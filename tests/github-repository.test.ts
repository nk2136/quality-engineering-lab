import { describe, expect, it } from 'vitest';
import type { KnowledgeQuery } from '../src/contracts.js';
import {
  GitHubApiError,
  GitHubRepositoryKnowledgeSource,
  type GitHubHttpClient,
  type GitHubHttpRequest,
} from '../src/github-repository.js';

const revision = 'a'.repeat(40);
const query: KnowledgeQuery = {
  traceId: '3d594650-3436-4d7c-86a7-2b94788009bc',
  text: 'eligibility authorization architecture',
  sources: ['github'],
  maxResults: 10,
  asOf: '2026-09-09T20:00:00.000Z',
};

function file(path: string, content: string, sha: string) {
  return {
    type: 'file',
    encoding: 'base64',
    size: Buffer.byteLength(content),
    path,
    sha,
    content: Buffer.from(content).toString('base64'),
  };
}

describe('GitHub repository knowledge source', () => {
  it('reads only configured paths at a pinned revision and ranks matching evidence', async () => {
    const requests: Array<{ url: string; init: GitHubHttpRequest }> = [];
    const httpClient: GitHubHttpClient = async (url, init) => {
      requests.push({ url, init });
      const path = url.includes('docs/architecture.md')
        ? 'docs/architecture.md'
        : 'tests/eligibility.spec.ts';
      const content = path.startsWith('docs/')
        ? 'Eligibility authorization architecture and service boundary.'
        : 'Eligibility request returns a successful response.';
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => file(path, content, path.startsWith('docs/') ? 'b'.repeat(40) : 'c'.repeat(40)),
      };
    };
    const source = new GitHubRepositoryKnowledgeSource({
      repository: 'acme/product',
      revision,
      paths: ['docs/architecture.md', 'tests/eligibility.spec.ts'],
      authorization: async () => 'Bearer runtime-secret',
      httpClient,
    });

    const result = await source.search(query);

    expect(requests).toHaveLength(2);
    expect(requests[0]?.url).toContain(`/contents/docs/architecture.md?ref=${revision}`);
    expect(requests[0]?.init).toMatchObject({
      method: 'GET',
      redirect: 'error',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: 'Bearer runtime-secret',
        'X-GitHub-Api-Version': '2026-03-10',
      },
    });
    expect(result.map((item) => item.uri)).toEqual([
      `https://github.com/acme/product/blob/${revision}/docs/architecture.md`,
      `https://github.com/acme/product/blob/${revision}/tests/eligibility.spec.ts`,
    ]);
    expect(result[0]).toMatchObject({ source: 'github', revision: 'b'.repeat(40), relevance: 1 });
  });

  it('returns no evidence and makes no request for another source', async () => {
    let calls = 0;
    const source = new GitHubRepositoryKnowledgeSource({
      repository: 'acme/product',
      revision,
      paths: ['README.md'],
      httpClient: async () => {
        calls += 1;
        throw new Error('HTTP should not be called.');
      },
    });

    expect(await source.search({ ...query, sources: ['jira'] })).toEqual([]);
    expect(calls).toBe(0);
  });

  it('rejects mutable revisions, unsafe paths, and duplicate manifests before HTTP', () => {
    expect(() => new GitHubRepositoryKnowledgeSource({
      repository: 'acme/product',
      revision: 'main',
      paths: ['README.md'],
    })).toThrow();
    expect(() => new GitHubRepositoryKnowledgeSource({
      repository: 'acme/product',
      revision,
      paths: ['../secrets.txt'],
    })).toThrow("GitHub repository path '../secrets.txt' must be a normalized relative file path.");
    expect(() => new GitHubRepositoryKnowledgeSource({
      repository: 'acme/product',
      revision,
      paths: ['README.md', 'README.md'],
    })).toThrow('GitHub repository paths must be unique.');
  });

  it('rejects oversized files and content integrity mismatches', async () => {
    const oversized = new GitHubRepositoryKnowledgeSource({
      repository: 'acme/product',
      revision,
      paths: ['docs/large.md'],
      maxFileBytes: 5,
      httpClient: async () => ({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => file('docs/large.md', 'too large', 'd'.repeat(40)),
      }),
    });
    await expect(oversized.search(query)).rejects.toThrow(
      "GitHub file 'docs/large.md' exceeds the 5-byte limit.",
    );

    const understated = new GitHubRepositoryKnowledgeSource({
      repository: 'acme/product',
      revision,
      paths: ['docs/understated.md'],
      maxFileBytes: 5,
      httpClient: async () => ({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({
          ...file('docs/understated.md', 'payload larger than declared', 'f'.repeat(40)),
          size: 1,
        }),
      }),
    });
    await expect(understated.search(query)).rejects.toThrow(
      "GitHub file 'docs/understated.md' exceeds the 5-byte limit.",
    );

    const mismatched = new GitHubRepositoryKnowledgeSource({
      repository: 'acme/product',
      revision,
      paths: ['docs/bad.md'],
      httpClient: async () => ({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({ ...file('docs/bad.md', 'text', 'e'.repeat(40)), size: 99 }),
      }),
    });
    await expect(mismatched.search(query)).rejects.toThrow(
      "GitHub file 'docs/bad.md' size does not match its decoded content.",
    );
  });

  it('returns a typed API error without exposing authorization', async () => {
    const source = new GitHubRepositoryKnowledgeSource({
      repository: 'acme/product',
      revision,
      paths: ['docs/private.md'],
      authorization: async () => 'Bearer do-not-expose',
      httpClient: async () => ({
        ok: false,
        status: 404,
        statusText: 'Not Found',
        json: async () => ({ message: 'Not Found' }),
      }),
    });

    let failure: unknown;
    try {
      await source.search(query);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(GitHubApiError);
    expect(failure).toMatchObject({ status: 404, path: 'docs/private.md' });
    expect((failure as Error).message).toBe('Not Found');
    expect((failure as Error).message).not.toContain('do-not-expose');
  });
});
