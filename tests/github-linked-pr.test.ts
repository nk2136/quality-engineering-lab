import { describe, expect, it } from 'vitest';
import type { KnowledgeQuery } from '../src/contracts.js';
import {
  GitHubLinkedPrKnowledgeSource,
  type GitHubPullRequestHttpClient,
} from '../src/github-linked-pr.js';

const query: KnowledgeQuery = {
  traceId: '3d594650-3436-4d7c-86a7-2b94788009bc',
  text: '123',
  sources: ['github'],
  maxResults: 10,
  asOf: '2026-10-15T15:00:00.000Z',
};

describe('GitHub linked PR knowledge source', () => {
  it('retrieves metadata for an explicitly allowlisted PR with immutable evidence', async () => {
    let requestedUrl = '';
    let requestedMethod = '';
    const source = new GitHubLinkedPrKnowledgeSource({
      repository: 'acme/product',
      allowedPrNumbers: [123],
      authorization: async () => 'Bearer runtime-secret',
      httpClient: async (url, request) => {
        requestedUrl = url;
        requestedMethod = request.method;
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => ({
            number: 123,
            id: 456,
            node_id: 'PR_node',
            html_url: 'https://github.com/acme/product/pull/123',
            title: 'Close readiness gap',
            body: 'Adds the verified path.',
            state: 'closed',
            draft: false,
            merged: true,
            merged_at: '2026-10-10T10:00:00Z',
            updated_at: '2026-10-10T10:00:00Z',
            head: { ref: 'feature/readiness', sha: 'b'.repeat(40) },
            base: { ref: 'main', sha: 'a'.repeat(40) },
            user: { login: 'maintainer' },
            labels: [{ name: 'quality' }],
          }),
        };
      },
    });

    const [evidence] = await source.search(query);
    expect(requestedUrl).toBe('https://api.github.com/repos/acme/product/pulls/123');
    expect(requestedMethod).toBe('GET');
    expect(evidence).toMatchObject({
      source: 'github',
      uri: 'https://github.com/acme/product/pull/123',
      revision: 'b'.repeat(40),
    });
    expect(JSON.parse(evidence!.content)).toMatchObject({ number: 123, merged: true, head: { sha: 'b'.repeat(40) } });
  });

  it('rejects a PR outside policy before resolving credentials or HTTP', async () => {
    let credentialCalls = 0;
    let httpCalls = 0;
    const source = new GitHubLinkedPrKnowledgeSource({
      repository: 'acme/product',
      allowedPrNumbers: [123],
      authorization: async () => { credentialCalls += 1; return 'Bearer secret'; },
      httpClient: async () => { httpCalls += 1; throw new Error('must not call HTTP'); },
    });

    await expect(source.search({ ...query, text: '#124' })).rejects.toThrow('not in configured allowlist');
    expect(credentialCalls).toBe(0);
    expect(httpCalls).toBe(0);
  });

  it('sanitizes provider failures', async () => {
    const source = new GitHubLinkedPrKnowledgeSource({
      repository: 'acme/product',
      allowedPrNumbers: [123],
      authorization: async () => 'Bearer do-not-expose',
      httpClient: async (_url, _request) => ({
        ok: false,
        status: 404,
        statusText: 'Not Found Bearer do-not-expose',
        json: async () => ({ message: 'Not Found Bearer do-not-expose' }),
      }),
    });

    await expect(source.search(query)).rejects.toMatchObject({ status: 404 });
    await expect(source.search(query)).rejects.not.toThrow('do-not-expose');
  });
});
