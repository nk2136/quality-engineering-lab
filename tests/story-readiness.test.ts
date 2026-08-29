import { describe, expect, it } from 'vitest';
import { buildContextPack, type ContextPack } from '../src/context.js';
import {
  finalizeStoryReadiness,
  type StoryReadinessDraft,
} from '../src/story-readiness.js';

function contextPack(): ContextPack {
  return buildContextPack({
    traceId: '3d594650-3436-4d7c-86a7-2b94788009bc',
    objective: 'Assess QE-42 for refinement readiness.',
    stage: 'refinement',
    sourceRevisions: { jira: 'QE-42@7' },
    acceptanceCriteria: ['Authorized users can submit a request.'],
    constraints: ['Use the existing authorization service.'],
    architectureFacts: ['The workflow API accepts requests.'],
    ownershipFacts: ['The workflow team owns the API.'],
    priorSignals: [],
    contradictions: ['The story says guests are allowed, but the API requires authentication.'],
    missingEvidence: ['Timeout behavior is not documented.'],
    maxTokens: 1_000,
    candidates: [
      {
        id: 'jira-story',
        source: 'jira',
        uri: 'https://example.atlassian.net/browse/QE-42',
        revision: '7',
        retrievedAt: '2026-08-29T20:00:00.000Z',
        content: 'Authorized users can submit a request.',
        estimatedTokens: 50,
        relevance: 1,
      },
    ],
  });
}

function draft(overrides: Partial<StoryReadinessDraft> = {}): StoryReadinessDraft {
  return {
    storyKey: 'QE-42',
    summary: 'Request submission needs refinement.',
    findings: [
      {
        id: 'FINDING-001',
        category: 'operability',
        severity: 'major',
        summary: 'Timeout behavior is unspecified.',
        impact: 'Timeout failures cannot be implemented or tested consistently.',
        basis: {
          kind: 'missing-evidence',
          missingEvidence: 'Timeout behavior is not documented.',
        },
      },
    ],
    refinementQuestions: [
      {
        question: 'What should happen when the dependency times out?',
        resolvesFindingIds: ['FINDING-001'],
      },
    ],
    suggestedAcceptanceCriteria: ['A dependency timeout returns a documented response.'],
    recommendedTestLayers: ['api', 'integration'],
    ...overrides,
  };
}

describe('story readiness assessment', () => {
  it('calculates the score and decision instead of accepting model-provided values', () => {
    const assessment = finalizeStoryReadiness(draft(), contextPack());

    expect(assessment.readinessScore).toBe(85);
    expect(assessment.decision).toBe('needs-refinement');
    expect(assessment.traceId).toBe(contextPack().traceId);
    expect(assessment.humanReview.status).toBe('pending');
  });

  it('marks a story ready only when remaining findings are minor', () => {
    const input = draft({
      findings: [
        {
          ...draft().findings[0]!,
          severity: 'minor',
          basis: { kind: 'evidence', evidenceIds: ['jira-story'] },
        },
      ],
    });

    const assessment = finalizeStoryReadiness(input, contextPack());

    expect(assessment.readinessScore).toBe(95);
    expect(assessment.decision).toBe('ready');
  });

  it('blocks a story when any finding is blocking', () => {
    const baseFinding = draft().findings[0]!;
    const input = draft({
      findings: [
        {
          ...baseFinding,
          severity: 'blocking',
          basis: {
            kind: 'contradiction',
            contradiction: 'The story says guests are allowed, but the API requires authentication.',
          },
        },
      ],
    });

    const assessment = finalizeStoryReadiness(input, contextPack());

    expect(assessment.readinessScore).toBe(70);
    expect(assessment.decision).toBe('blocked');
  });

  it('rejects citations that are not present in the context pack', () => {
    const baseFinding = draft().findings[0]!;
    const input = draft({
      findings: [
        {
          ...baseFinding,
          basis: { kind: 'evidence', evidenceIds: ['invented-source'] },
        },
      ],
    });

    expect(() => finalizeStoryReadiness(input, contextPack())).toThrow(
      "Finding 'FINDING-001' cites unknown evidence: invented-source.",
    );
  });

  it('rejects duplicate findings and questions that reference unknown findings', () => {
    const baseFinding = draft().findings[0]!;
    const duplicate = draft({ findings: [baseFinding, baseFinding] });
    expect(() => finalizeStoryReadiness(duplicate, contextPack())).toThrow(
      'Finding IDs must be unique.',
    );

    const danglingQuestion = draft({
      refinementQuestions: [
        { question: 'Who owns this decision?', resolvesFindingIds: ['FINDING-999'] },
      ],
    });
    expect(() => finalizeStoryReadiness(danglingQuestion, contextPack())).toThrow(
      'Refinement question references unknown findings: FINDING-999.',
    );
  });

  it('floors readiness at zero for many unresolved findings', () => {
    const baseFinding = draft().findings[0]!;
    const findings = Array.from({ length: 8 }, (_, index) => ({
      ...baseFinding,
      id: `FINDING-${String(index + 1).padStart(3, '0')}`,
      severity: 'major' as const,
    }));

    const assessment = finalizeStoryReadiness(
      draft({ findings, refinementQuestions: [] }),
      contextPack(),
    );

    expect(assessment.readinessScore).toBe(0);
    expect(assessment.decision).toBe('needs-refinement');
  });
});
