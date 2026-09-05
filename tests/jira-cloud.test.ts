import { describe, expect, it } from 'vitest';
import type { KnowledgeQuery } from '../src/contracts.js';
import type { JiraHttpClient, JiraHttpRequest } from '../src/jira-cloud.js';
import { JiraApiError, JiraCloudKnowledgeSource, adfToText } from '../src/jira-cloud.js';

const query: KnowledgeQuery = {
  traceId: '3d594650-3436-4d7c-86a7-2b94788009bc',
  text: 'QE-42',
  sources: ['jira'],
  maxResults: 10,
  asOf: '2026-09-05T20:00:00.000Z',
};

function jiraIssue() {
  return {
    id: '10042',
    key: 'QE-42',
    fields: {
      summary: 'Submit an eligibility request',
      description: {
        version: 1,
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: 'Given an active member, ' },
              { type: 'mention', attrs: { text: '@Eligibility Team' } },
            ],
          },
          {
            type: 'paragraph',
            content: [{ type: 'text', text: 'return the eligibility status.' }],
          },
        ],
      },
      updated: '2026-09-05T19:30:00.000+0000',
      status: { name: 'Refinement' },
      issuetype: { name: 'Story' },
      priority: { name: 'High' },
      labels: ['eligibility'],
      components: [{ name: 'Gateway' }],
      fixVersions: [{ name: '2026.09' }],
      parent: { key: 'QE-10', fields: { summary: 'Eligibility modernization' } },
      issuelinks: [
        {
          type: { inward: 'is blocked by', outward: 'blocks' },
          outwardIssue: { key: 'QE-43', fields: { summary: 'Gateway contract update' } },
        },
      ],
    },
  };
}

describe('Jira Cloud knowledge source', () => {
  it('normalizes a Jira issue and ADF description into deterministic evidence', async () => {
    let requestedUrl = '';
    let requestedInit: JiraHttpRequest | undefined;
    const httpClient: JiraHttpClient = async (url, init) => {
      requestedUrl = url;
      requestedInit = init;
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => jiraIssue(),
      };
    };
    const source = new JiraCloudKnowledgeSource({
      baseUrl: 'https://example.atlassian.net/',
      authorization: async () => 'Basic runtime-secret',
      httpClient,
    });

    const result = await source.search(query);

    expect(requestedUrl).toContain('/rest/api/3/issue/QE-42?fields=summary,description');
    expect(requestedInit).toMatchObject({
      method: 'GET',
      redirect: 'error',
      headers: { Accept: 'application/json', Authorization: 'Basic runtime-secret' },
    });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: 'jira:10042:2026-09-05T19:30:00.000+0000',
      source: 'jira',
      uri: 'https://example.atlassian.net/browse/QE-42',
      revision: '2026-09-05T19:30:00.000+0000',
      retrievedAt: query.asOf,
      relevance: 1,
    });
    expect(JSON.parse(result[0]!.content)).toMatchObject({
      key: 'QE-42',
      description: 'Given an active member, @Eligibility Team\nreturn the eligibility status.',
      components: ['Gateway'],
      parent: { key: 'QE-10' },
      links: [{ relationship: 'blocks', key: 'QE-43' }],
    });
  });

  it('returns no evidence without Jira in the requested source set', async () => {
    let calls = 0;
    const source = new JiraCloudKnowledgeSource({
      baseUrl: 'https://example.atlassian.net',
      httpClient: async () => {
        calls += 1;
        throw new Error('HTTP should not be called.');
      },
    });

    const result = await source.search({ ...query, sources: ['github'] });

    expect(result).toEqual([]);
    expect(calls).toBe(0);
  });

  it('rejects broad queries instead of converting uncontrolled text into JQL', async () => {
    const source = new JiraCloudKnowledgeSource({
      baseUrl: 'https://example.atlassian.net',
      httpClient: async () => { throw new Error('HTTP should not be called.'); },
    });

    await expect(source.search({ ...query, text: 'Find stories in QE' })).rejects.toThrow();
  });

  it('returns a typed, sanitized Jira error without exposing authorization', async () => {
    const source = new JiraCloudKnowledgeSource({
      baseUrl: 'https://example.atlassian.net',
      authorization: async () => 'Basic do-not-expose',
      httpClient: async () => ({
        ok: false,
        status: 404,
        statusText: 'Not Found',
        json: async () => ({ errorMessages: ['Issue does not exist or is not visible.'] }),
      }),
    });

    let failure: unknown;
    try {
      await source.search(query);
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(JiraApiError);
    expect(failure).toMatchObject({ status: 404 });
    expect((failure as Error).message).toBe('Issue does not exist or is not visible.');
    expect((failure as Error).message).not.toContain('do-not-expose');
  });

  it('rejects insecure base URLs and normalizes supported ADF inline nodes', () => {
    expect(() => new JiraCloudKnowledgeSource({ baseUrl: 'http://jira.example.test' }))
      .toThrow('Jira Cloud baseUrl must use HTTPS.');
    expect(adfToText({
      type: 'paragraph',
      content: [
        { type: 'emoji', attrs: { shortName: ':warning:' } },
        { type: 'hardBreak' },
        { type: 'inlineCard', attrs: { url: 'https://example.test/adr/1' } },
      ],
    })).toBe(':warning:\nhttps://example.test/adr/1');
  });
});
