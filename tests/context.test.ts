import { describe, expect, it } from 'vitest';
import {
  ContextPackSchema,
  buildContextPack,
  type ContextEvidence,
  type ContextPackInput,
} from '../src/context.js';

const baseInput: Omit<ContextPackInput, 'candidates' | 'maxTokens'> = {
  traceId: '3d594650-3436-4d7c-86a7-2b94788009bc',
  objective: 'Assess STORY-42 for refinement readiness.',
  stage: 'refinement',
  sourceRevisions: { jira: 'STORY-42@7' },
  acceptanceCriteria: ['Authorized users can submit the request.'],
  constraints: ['Use the existing authorization service.'],
  architectureFacts: ['Requests are accepted by the workflow API.'],
  ownershipFacts: ['Workflow team owns the API.'],
  priorSignals: [],
  contradictions: [],
  missingEvidence: ['Rate-limit behavior is not documented.'],
};

function evidence(overrides: Partial<ContextEvidence>): ContextEvidence {
  return {
    id: 'evidence-1',
    source: 'jira',
    uri: 'https://example.atlassian.net/browse/STORY-42',
    revision: '7',
    retrievedAt: '2026-08-24T18:00:00.000Z',
    content: 'A user can submit a workflow request.',
    estimatedTokens: 100,
    relevance: 0.9,
    ...overrides,
  };
}

describe('context pack', () => {
  it('selects evidence deterministically by relevance while respecting the budget', () => {
    const pack = buildContextPack({
      ...baseInput,
      maxTokens: 350,
      reservedTokens: 150,
      candidates: [
        evidence({ id: 'medium', uri: 'https://example.test/medium', relevance: 0.7 }),
        evidence({ id: 'high', uri: 'https://example.test/high', relevance: 0.95 }),
        evidence({ id: 'low', uri: 'https://example.test/low', relevance: 0.4 }),
      ],
    });

    expect(pack.evidence.map((item) => item.id)).toEqual(['high', 'medium']);
    expect(pack.omittedEvidenceIds).toEqual(['low']);
    expect(pack.budget).toEqual({
      maxTokens: 350,
      reservedTokens: 150,
      evidenceTokenLimit: 200,
      usedEvidenceTokens: 200,
    });
    expect(pack.truncated).toBe(true);
  });

  it('deduplicates the same source revision and keeps the higher-relevance candidate', () => {
    const pack = buildContextPack({
      ...baseInput,
      maxTokens: 500,
      candidates: [
        evidence({ id: 'older-summary', relevance: 0.6 }),
        evidence({ id: 'preferred-summary', relevance: 0.95 }),
      ],
    });

    expect(pack.evidence.map((item) => item.id)).toEqual(['preferred-summary']);
    expect(pack.omittedEvidenceIds).toEqual(['older-summary']);
  });

  it('rejects packs whose recorded token usage does not match their evidence', () => {
    const pack = buildContextPack({
      ...baseInput,
      maxTokens: 500,
      candidates: [evidence({})],
    });

    const result = ContextPackSchema.safeParse({
      ...pack,
      budget: { ...pack.budget, usedEvidenceTokens: 99 },
    });

    expect(result.success).toBe(false);
  });

  it('rejects a reserved budget larger than the total budget', () => {
    expect(() =>
      buildContextPack({
        ...baseInput,
        maxTokens: 100,
        reservedTokens: 101,
        candidates: [],
      }),
    ).toThrow('Reserved tokens cannot exceed the total context budget.');
  });
});
