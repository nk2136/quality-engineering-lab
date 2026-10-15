import { describe, expect, it } from 'vitest';
import type { ContextEvidence } from '../src/context.js';
import type { KnowledgeQuery, KnowledgeSource } from '../src/contracts.js';
import {
  RequirementsInvestigator,
  type RequirementsInvestigatorDependencies,
} from '../src/requirements-investigator.js';

const traceId = '3d594650-3436-4d7c-86a7-2b94788009bc';
const asOf = '2026-10-15T18:05:00.000Z';
const sourceRevision = 'a'.repeat(40);

function evidence(
  id: string,
  source: ContextEvidence['source'],
  content: string,
  revision = sourceRevision,
): ContextEvidence {
  return {
    id,
    source,
    uri: `https://example.test/${id}`,
    revision,
    retrievedAt: asOf,
    content,
    estimatedTokens: Math.max(1, Math.ceil(content.length / 4)),
    relevance: 1,
  };
}

class RecordingSource implements KnowledgeSource {
  readonly queries: KnowledgeQuery[] = [];

  constructor(private readonly result: readonly ContextEvidence[]) {}

  async search(query: KnowledgeQuery): Promise<readonly ContextEvidence[]> {
    this.queries.push(query);
    return this.result;
  }
}

function dependencies(overrides: Partial<RequirementsInvestigatorDependencies> = {}) {
  const base = {
    ticket: new RecordingSource([
      evidence(
        'jira-QE-42',
        'jira',
        JSON.stringify({
          key: 'QE-42',
          summary: 'Reject inactive members',
          acceptanceCriteria: ['Inactive members receive a rejection.'],
          component: 'membership-service',
        }),
        'jira-rev-7',
      ),
    ]),
    history: new RecordingSource([
      evidence(
        'history-QE-41',
        'jira',
        JSON.stringify({
          storyKey: 'QE-41',
          summary: 'Add inactive-member audit event',
          relevance: 'The error contract is shared by the continuation story.',
        }),
        'jira-rev-6',
      ),
    ]),
    source: new RecordingSource([
      evidence(
        'github-membership',
        'github',
        JSON.stringify({
          component: 'membership-service',
          branch: 'main',
          revision: sourceRevision,
          files: ['src/membership.ts'],
        }),
      ),
    ]),
    tests: new RecordingSource([
      evidence(
        'test-membership',
        'test',
        JSON.stringify({
          path: 'tests/membership.spec.ts',
          covers: ['Inactive members receive a rejection.'],
        }),
      ),
    ]),
  };
  const sources = {
    ticket: (overrides.ticket ?? base.ticket) as RecordingSource,
    history: (overrides.history ?? base.history) as RecordingSource,
    source: (overrides.source ?? base.source) as RecordingSource,
    tests: (overrides.tests ?? base.tests) as RecordingSource,
  } satisfies RequirementsInvestigatorDependencies;

  return {
    ...sources,
    investigator: new RequirementsInvestigator(sources),
  };
}

describe('RequirementsInvestigator', () => {
  it('retrieves each bounded read-only source and emits cited AC, component, revision, and history facts', async () => {
    const setup = dependencies();
    const result = await setup.investigator.investigate({
      traceId,
      storyKey: 'QE-42',
      sourceRevision,
      asOf,
    });

    expect(setup.ticket.queries[0]).toMatchObject({ text: 'QE-42', sources: ['jira'] });
    expect(setup.history.queries[0]).toMatchObject({ text: 'QE-42 history', sources: ['jira'] });
    expect(setup.source.queries[0]).toMatchObject({ text: 'QE-42', sources: ['github'] });
    expect(setup.tests.queries[0]).toMatchObject({ text: 'QE-42', sources: ['test'] });
    expect(result.readinessPackage).toMatchObject({
      storyKey: 'QE-42',
      component: 'membership-service',
      revision: sourceRevision,
      acceptanceCriteria: [{ id: 'AC-1', statement: 'Inactive members receive a rejection.' }],
      historicalRelevance: [
        expect.objectContaining({ evidenceIds: ['history-QE-41'] }),
      ],
    });
    expect(result.readinessPackage.acceptanceCriteria[0]?.evidenceIds).toEqual(['jira-QE-42']);
    expect(result.readinessPackage.provenance.sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'github-membership', revision: sourceRevision }),
      ]),
    );
    expect(result.readinessPackage.proposedReadinessDecision).toBe('ready');
  });

  it('turns ambiguous criteria and missing implementation evidence into owned clarification and blocker records', async () => {
    const setup = dependencies({
      ticket: new RecordingSource([
        evidence(
          'jira-QE-43',
          'jira',
          JSON.stringify({ key: 'QE-43', summary: 'Handle export', acceptanceCriteria: ['The export should be fast.'] }),
          'jira-rev-8',
        ),
      ]),
      source: new RecordingSource([]),
      tests: new RecordingSource([]),
    });

    const result = await setup.investigator.investigate({
      traceId,
      storyKey: 'QE-43',
      sourceRevision,
      asOf,
    });

    expect(result.readinessPackage.ownedClarifications).toEqual([
      expect.objectContaining({ id: 'QUESTION-1', owner: 'product' }),
    ]);
    expect(result.readinessPackage.phaseSpecificBlockers).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'BLOCKER-1', phase: 'refinement' }),
    ]));
    expect(result.readinessPackage.proposedReadinessDecision).toBe('blocked');
  });

  it('does not expose credentials or allow a source revision mismatch to be treated as current evidence', async () => {
    const setup = dependencies({
      source: new RecordingSource([
        evidence('github-stale', 'github', JSON.stringify({ component: 'membership-service' }), 'stale-revision'),
      ]),
    });

    const result = await setup.investigator.investigate({
      traceId,
      storyKey: 'QE-42',
      sourceRevision,
      asOf,
    });

    expect(result.readinessPackage.phaseSpecificBlockers).toEqual([
      expect.objectContaining({ description: expect.stringContaining('does not match') }),
    ]);
    expect(setup.source.queries[0]).not.toHaveProperty('authorization');
    expect(setup.source.queries[0]).not.toHaveProperty('token');
  });
});
