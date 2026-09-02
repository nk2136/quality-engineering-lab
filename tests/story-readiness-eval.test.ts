import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { StoryReadinessAssessment } from '../src/story-readiness.js';
import {
  StoryReadinessGoldenCaseSchema,
  evaluateStoryReadiness,
  type StoryReadinessGoldenCase,
} from '../src/story-readiness-eval.js';

const corpus = StoryReadinessGoldenCaseSchema.array().parse(
  JSON.parse(
    readFileSync(new URL('../evals/story-readiness-cases.json', import.meta.url), 'utf8'),
  ),
);

function goldenCase(id: string): StoryReadinessGoldenCase {
  const result = corpus.find((item) => item.id === id);
  if (result === undefined) throw new Error(`Golden case '${id}' was not found.`);
  return result;
}

function assessment(
  overrides: Partial<StoryReadinessAssessment> = {},
): StoryReadinessAssessment {
  return {
    schemaVersion: '1.0',
    traceId: '3d594650-3436-4d7c-86a7-2b94788009bc',
    storyKey: 'QE-102',
    summary: 'Timeout behavior needs refinement.',
    readinessScore: 85,
    decision: 'needs-refinement',
    findings: [
      {
        id: 'FINDING-001',
        category: 'operability',
        severity: 'major',
        summary: 'Provider timeout behavior is missing.',
        impact: 'A timeout cannot be handled or tested consistently.',
        basis: {
          kind: 'missing-evidence',
          missingEvidence: 'Provider gateway timeout behavior is not documented.',
        },
      },
    ],
    refinementQuestions: [
      {
        question: 'What response should a gateway timeout produce?',
        resolvesFindingIds: ['FINDING-001'],
      },
    ],
    suggestedAcceptanceCriteria: ['A gateway timeout returns a documented response.'],
    recommendedTestLayers: ['api', 'integration'],
    humanReview: { status: 'pending', reviewer: null, reviewedAt: null },
    ...overrides,
  };
}

describe('Story Readiness evaluation', () => {
  it('validates a corpus spanning ready, refinement, and blocked verdicts', () => {
    expect(corpus).toHaveLength(3);
    expect(new Set(corpus.map((item) => item.expectedDecision))).toEqual(
      new Set(['ready', 'needs-refinement', 'blocked']),
    );
  });

  it('passes when decision, expected gaps, and provenance agree with the golden case', () => {
    const report = evaluateStoryReadiness(
      assessment(),
      goldenCase('refine-missing-timeout'),
    );

    expect(report).toEqual({
      caseId: 'refine-missing-timeout',
      passed: true,
      decisionAgreement: true,
      gapRecall: 1,
      citationFaithfulness: 1,
      matchedGapIds: ['timeout-behavior'],
      missingGapIds: [],
      invalidFindingIds: [],
    });
  });

  it('reports a missed gap when severity or required terms do not match', () => {
    const actual = assessment({
      findings: [
        {
          ...assessment().findings[0]!,
          severity: 'minor',
          summary: 'The response needs clarification.',
          impact: 'Assertions may vary.',
        },
      ],
    });

    const report = evaluateStoryReadiness(actual, goldenCase('refine-missing-timeout'));

    expect(report.gapRecall).toBe(0);
    expect(report.missingGapIds).toEqual(['timeout-behavior']);
    expect(report.passed).toBe(false);
  });

  it('detects unsupported citations independently from decision agreement', () => {
    const actual = assessment({
      findings: [
        {
          ...assessment().findings[0]!,
          basis: { kind: 'evidence', evidenceIds: ['unretrieved-document'] },
        },
      ],
    });

    const report = evaluateStoryReadiness(actual, goldenCase('refine-missing-timeout'));

    expect(report.decisionAgreement).toBe(true);
    expect(report.citationFaithfulness).toBe(0);
    expect(report.invalidFindingIds).toEqual(['FINDING-001']);
    expect(report.passed).toBe(false);
  });

  it('does not allow one finding to satisfy two expected gaps', () => {
    const baseCase = goldenCase('refine-missing-timeout');
    const duplicateExpectation = {
      ...baseCase,
      expectedGaps: [
        ...baseCase.expectedGaps,
        { ...baseCase.expectedGaps[0]!, id: 'second-timeout-gap' },
      ],
    };

    const report = evaluateStoryReadiness(assessment(), duplicateExpectation);

    expect(report.gapRecall).toBe(0.5);
    expect(report.matchedGapIds).toEqual(['timeout-behavior']);
    expect(report.missingGapIds).toEqual(['second-timeout-gap']);
  });
});
