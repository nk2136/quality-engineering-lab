import { describe, expect, it } from 'vitest';
import type { KnowledgeQuery } from '../src/contracts.js';
import {
  JiraHistoricalContextKnowledgeSource,
  type JiraHistoricalHttpClient,
} from '../src/jira-historical-context.js';

const query: KnowledgeQuery = {
  traceId: '3d594650-3436-4d7c-86a7-2b94788009bc',
  text: 'QE-42',
  sources: ['jira'],
  maxResults: 10,
  asOf: '2026-10-15T15:00:00.000Z',
};

const response = (body: unknown) => ({
  ok: true,
  status: 200,
  statusText: 'OK',
  json: async () => body,
});

describe('Jira historical context knowledge source', () => {
  it('retrieves bounded comments and changelog with GET-only requests', async () => {
    const requests: Array<{ url: string; method: string; redirect: string }> = [];
    const httpClient: JiraHistoricalHttpClient = async (url, request) => {
      requests.push({ url, method: request.method, redirect: request.redirect });
      if (url.includes('/comment?')) {
        return response({
          startAt: 0,
          maxResults: 2,
          total: 4,
          comments: [
            { id: 'c1', author: { displayName: 'QA' }, created: '2026-10-01T10:00:00.000+0000', body: 'Accepted after review.' },
            { id: 'c2', author: { displayName: 'Dev' }, created: '2026-10-02T10:00:00.000+0000', body: 'Fixed in the linked change.' },
          ],
        });
      }
      return response({
        startAt: 0,
        maxResults: 3,
        total: 3,
        values: [{
          id: 'h1',
          created: '2026-10-03T10:00:00.000+0000',
          author: { displayName: 'Dev' },
          items: [{ field: 'status', fromString: 'Open', toString: 'Done' }],
        }],
      });
    };

    const source = new JiraHistoricalContextKnowledgeSource({
      baseUrl: 'https://example.atlassian.net',
      allowedIssueKeys: ['QE-42'],
      maxComments: 2,
      maxChangelogEntries: 3,
      authorization: async () => 'Bearer runtime-secret',
      httpClient,
    });

    const [evidence] = await source.search(query);
    expect(requests).toHaveLength(2);
    expect(requests.every((request) => request.method === 'GET' && request.redirect === 'error')).toBe(true);
    expect(requests[0]?.url).toContain('/rest/api/3/issue/QE-42/comment?startAt=0&maxResults=2');
    expect(requests[1]?.url).toContain('/rest/api/3/issue/QE-42/changelog?startAt=0&maxResults=3');
    expect(evidence).toMatchObject({ source: 'jira', uri: 'https://example.atlassian.net/browse/QE-42' });
    expect(JSON.parse(evidence!.content)).toMatchObject({
      issueKey: 'QE-42',
      comments: [{ id: 'c1' }, { id: 'c2' }],
      changelog: [{ id: 'h1', items: [{ field: 'status', to: 'Done' }] }],
    });
  });

  it('rejects a key outside policy before resolving credentials or HTTP', async () => {
    let credentialCalls = 0;
    let httpCalls = 0;
    const source = new JiraHistoricalContextKnowledgeSource({
      baseUrl: 'https://example.atlassian.net',
      allowedIssueKeys: ['QE-42'],
      authorization: async () => { credentialCalls += 1; return 'Bearer secret'; },
      httpClient: async () => { httpCalls += 1; throw new Error('must not call HTTP'); },
    });

    await expect(source.search({ ...query, text: 'QE-43' })).rejects.toThrow('not in configured allowlist');
    expect(credentialCalls).toBe(0);
    expect(httpCalls).toBe(0);
  });

  it('sanitizes provider failures', async () => {
    const source = new JiraHistoricalContextKnowledgeSource({
      baseUrl: 'https://example.atlassian.net',
      allowedIssueKeys: ['QE-42'],
      authorization: async () => 'Bearer do-not-expose',
      httpClient: async () => ({
        ok: false,
        status: 403,
        statusText: 'Forbidden Bearer do-not-expose',
        json: async () => ({ errorMessages: ['Forbidden Bearer do-not-expose'] }),
      }),
    });

    await expect(source.search(query)).rejects.toMatchObject({ status: 403 });
    await expect(source.search(query)).rejects.not.toThrow('do-not-expose');
  });
});
