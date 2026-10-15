import { describe, expect, it } from 'vitest';
import { ReadinessPackageSchema } from '../src/schemas.js';
import { validateReadinessPackage } from '../src/readiness-validator.js';

const traceId = '3d594650-3436-4d7c-86a7-2b94788009bc';

function packageValue(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: '1.0',
    packageId: 'readiness:QE-42:1',
    traceId,
    storyKey: 'QE-42',
    createdAt: '2026-10-15T12:00:00.000Z',
    provenance: {
      sources: [
        {
          id: 'jira-QE-42',
          source: 'jira',
          revision: 'jira-rev-7',
          evidenceIds: ['jira-QE-42'],
        },
      ],
    },
    acceptanceCriteria: [
      {
        id: 'AC-1',
        statement: 'Inactive members are rejected.',
        evidenceIds: ['jira-QE-42'],
      },
    ],
    confirmedFacts: [
      {
        id: 'FACT-1',
        statement: 'The membership service owns the decision.',
        evidenceIds: ['jira-QE-42'],
      },
    ],
    historicalRelevance: [
      {
        id: 'HISTORY-1',
        statement: 'Existing inactive-member coverage is relevant to the error contract.',
        relevance: 'supports',
        evidenceIds: ['jira-QE-42'],
      },
    ],
    acVerificationMap: [
      {
        acId: 'AC-1',
        expectedBehavior: 'An inactive member request is rejected.',
        observableOutcome: 'The response is HTTP 403 with the documented rejection body.',
        verificationMethods: [
          {
            id: 'METHOD-1',
            description: 'API contract test against the membership endpoint.',
            status: 'candidate',
            evidenceIds: ['jira-QE-42'],
          },
        ],
        evidenceIds: ['jira-QE-42'],
      },
    ],
    accessDataPrerequisites: [
      {
        id: 'PREREQ-1',
        description: 'A fixture for an inactive member.',
        status: 'available',
        evidenceIds: ['jira-QE-42'],
      },
    ],
    ownedClarifications: [],
    phaseSpecificBlockers: [],
    proposedReadinessDecision: 'ready',
    ...overrides,
  };
}

describe('ReadinessPackageSchema', () => {
  it('accepts an evidence-backed readiness package', () => {
    expect(ReadinessPackageSchema.safeParse(packageValue()).success).toBe(true);
  });

  it('rejects an AC map entry without an observable outcome or method', () => {
    const value = packageValue({
      acVerificationMap: [{ acId: 'AC-1', expectedBehavior: 'Reject inactive members.' }],
    });

    expect(ReadinessPackageSchema.safeParse(value).success).toBe(false);
  });
});

describe('validateReadinessPackage', () => {
  it('requires every AC to have exactly one evidence-backed verification mapping', () => {
    const value = packageValue({
      acceptanceCriteria: [
        ...((packageValue() as { acceptanceCriteria: unknown[] }).acceptanceCriteria),
        { id: 'AC-2', statement: 'The rejection is auditable.', evidenceIds: ['jira-QE-42'] },
      ],
    });

    expect(() => validateReadinessPackage(value)).toThrow("Acceptance criterion 'AC-2' has no verification mapping.");
  });

  it('rejects citations outside the declared provenance and inconsistent ready decisions', () => {
    const value = packageValue({
      proposedReadinessDecision: 'ready',
      ownedClarifications: [
        {
          id: 'QUESTION-1',
          question: 'Which rejection body is canonical?',
          owner: 'Product',
          evidenceIds: ['unknown-evidence'],
        },
      ],
    });

    expect(() => validateReadinessPackage(value)).toThrow("Evidence 'unknown-evidence' is not declared in provenance.");
  });

  it('returns a normalized package when all references and gates are valid', () => {
    expect(validateReadinessPackage(packageValue())).toMatchObject({
      packageId: 'readiness:QE-42:1',
      proposedReadinessDecision: 'ready',
    });
  });
});
