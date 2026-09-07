import { describe, expect, it } from 'vitest';
import type { ContextEvidence } from '../src/context.js';
import type { KnowledgeQuery, KnowledgeSource } from '../src/contracts.js';
import {
  CompositeKnowledgeSource,
  assembleKnowledge,
} from '../src/knowledge-assembler.js';

const traceId = 'ffeb0f14-cfce-4578-8faf-58cf5a04dc8f';

function evidence(
  id: string,
  source: ContextEvidence['source'],
  relevance: number,
  uri = `https://example.test/${id}`,
): ContextEvidence {
  return {
    id,
    source,
    uri,
    revision: '1',
    retrievedAt: '2026-09-07T20:00:00.000Z',
    content: `Evidence ${id}`,
    estimatedTokens: 10,
    relevance,
  };
}

class RecordingSource implements KnowledgeSource {
  readonly queries: KnowledgeQuery[] = [];

  constructor(private readonly results: readonly ContextEvidence[]) {}

  async search(query: KnowledgeQuery): Promise<readonly ContextEvidence[]> {
    this.queries.push(query);
    return this.results;
  }
}

describe('knowledge assembly', () => {
  it('dispatches source-specific queries and applies deterministic global limits', async () => {
    const jira = new RecordingSource([evidence('jira-story', 'jira', 0.8)]);
    const github = new RecordingSource([
      evidence('github-adr', 'github', 1),
      evidence('github-duplicate', 'github', 0.9, 'https://example.test/github-adr'),
    ]);
    const composite = new CompositeKnowledgeSource({ jira, github });

    const result = await assembleKnowledge({
      traceId,
      asOf: '2026-09-07T20:00:00.000Z',
      queries: [
        { source: 'jira', text: 'QE-42', maxResults: 1 },
        { source: 'github', text: 'authorization architecture', maxResults: 5 },
      ],
      maxTotalResults: 2,
    }, composite);

    expect(jira.queries[0]).toMatchObject({ text: 'QE-42', sources: ['jira'] });
    expect(github.queries[0]).toMatchObject({
      text: 'authorization architecture',
      sources: ['github'],
    });
    expect(result.map((item) => item.id)).toEqual(['github-adr', 'jira-story']);
  });

  it('rejects evidence attributed to a different source', async () => {
    const badAdapter = new RecordingSource([evidence('wrong', 'test', 1)]);

    await expect(assembleKnowledge({
      traceId,
      asOf: '2026-09-07T20:00:00.000Z',
      queries: [{ source: 'github', text: 'architecture', maxResults: 5 }],
      maxTotalResults: 5,
    }, badAdapter)).rejects.toThrow(
      "Knowledge adapter for 'github' returned 'test' evidence 'wrong'.",
    );
  });

  it('rejects duplicate plans and missing composite adapters', async () => {
    const composite = new CompositeKnowledgeSource({});
    await expect(composite.search({
      traceId,
      text: 'QE-42',
      sources: ['jira'],
      maxResults: 1,
      asOf: '2026-09-07T20:00:00.000Z',
    })).rejects.toThrow("No knowledge adapter is configured for 'jira'.");

    await expect(assembleKnowledge({
      traceId,
      asOf: '2026-09-07T20:00:00.000Z',
      queries: [
        { source: 'jira', text: 'QE-42', maxResults: 1 },
        { source: 'jira', text: 'QE-43', maxResults: 1 },
      ],
      maxTotalResults: 2,
    }, composite)).rejects.toThrow("Knowledge assembly has more than one query for 'jira'.");
  });
});
