import { describe, expect, it } from 'vitest';
import type { KnowledgeQuery } from '../src/contracts.js';
import { createLiveReadinessKnowledgeSource } from '../src/live-readiness-adapters.js';

const revision = 'a'.repeat(40);
const query: KnowledgeQuery = {
  traceId: 'a2b34adb-52c3-4ea5-8c79-eb119b92ef26',
  text: 'QE-42',
  sources: ['jira'],
  maxResults: 10,
  asOf: '2026-09-29T22:00:00.000Z',
};

describe('live readiness knowledge adapters', () => {
  it('uses identical read-only request controls for allowlisted Jira and GitHub retrieval', async () => {
    const requests: Array<{ provider: string; method: string; redirect: string }> = [];
    const source = createLiveReadinessKnowledgeSource({
      jira: { baseUrl: 'https://example.atlassian.net', allowedIssueKeys: ['QE-42'] },
      github: { repository: 'acme/product', revision, paths: ['docs/architecture.md'] },
    }, {
      jiraHttpClient: async (_url, request) => {
        requests.push({ provider: 'jira', method: request.method, redirect: request.redirect });
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => ({
            id: '10042', key: 'QE-42', fields: {
              summary: 'Readiness story', updated: '2026-09-29T21:00:00.000+0000',
              status: { name: 'Refinement' }, issuetype: { name: 'Story' }, issuelinks: [],
            },
          }),
        };
      },
      githubHttpClient: async (_url, request) => {
        requests.push({ provider: 'github', method: request.method, redirect: request.redirect });
        const content = 'Architecture documents eligibility authorization.';
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => ({
            type: 'file', encoding: 'base64', path: 'docs/architecture.md', sha: 'b'.repeat(40),
            size: Buffer.byteLength(content), content: Buffer.from(content).toString('base64'),
          }),
        };
      },
    });

    await source.search(query);
    await source.search({ ...query, text: 'architecture', sources: ['github'] });

    expect(requests).toEqual([
      { provider: 'jira', method: 'GET', redirect: 'error' },
      { provider: 'github', method: 'GET', redirect: 'error' },
    ]);
  });

  it('rejects a Jira key outside policy before resolving credentials or HTTP', async () => {
    let credentialCalls = 0;
    let httpCalls = 0;
    const source = createLiveReadinessKnowledgeSource({
      jira: { baseUrl: 'https://example.atlassian.net', allowedIssueKeys: ['QE-42'] },
      github: { repository: 'acme/product', revision, paths: ['README.md'] },
    }, {
      credentials: { jira: async () => { credentialCalls += 1; return 'Bearer do-not-expose'; } },
      jiraHttpClient: async () => { httpCalls += 1; throw new Error('HTTP should not be called.'); },
    });

    await expect(source.search({ ...query, text: 'QE-43' })).rejects.toThrow(
      "Jira issue 'QE-43' is not in the configured allowlist.",
    );
    expect(credentialCalls).toBe(0);
    expect(httpCalls).toBe(0);
  });
});
