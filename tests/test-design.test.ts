import { describe, expect, it } from 'vitest';
import {
  TestDesignSchema,
  buildTestDesign,
  type TestDesignInput,
} from '../src/test-design.js';

const basePackage = {
  schemaVersion: '1.0' as const,
  packageId: 'readiness:QE-42:rev-7',
  traceId: '3d594650-3436-4d7c-86a7-2b94788009bc',
  storyKey: 'QE-42',
  revision: 'rev-7',
  component: 'request-api',
  createdAt: '2026-10-15T12:00:00.000Z',
  acceptanceCriteria: [
    {
      id: 'AC-1',
      statement: 'Authorized users can submit a request.',
      evidenceIds: ['jira-QE-42'],
    },
    {
      id: 'AC-2',
      statement: 'Invalid request values are rejected with a validation error.',
      evidenceIds: ['jira-QE-42'],
    },
  ],
  rtm: [
    {
      id: 'RTM-001',
      acId: 'AC-1',
      expectedBehavior: 'Authorized users can submit a request.',
      observableOutcome: 'A request is created and its identifier is returned.',
      verificationMethods: ['existing-test-1'],
      evidenceIds: ['jira-QE-42'],
    },
    {
      id: 'RTM-002',
      acId: 'AC-2',
      expectedBehavior: 'Invalid request values are rejected with a validation error.',
      observableOutcome: 'A validation error is returned and no request is created.',
      verificationMethods: ['existing-test-2'],
      evidenceIds: ['jira-QE-42'],
    },
  ],
  discrepancyRows: [],
  provenance: { sources: [{ id: 'jira-QE-42', source: 'jira', revision: 'jira-7', evidenceIds: ['jira-QE-42'] }] },
  confirmedFacts: [],
  historicalRelevance: [],
  acVerificationMap: [],
  accessDataPrerequisites: [{ id: 'PREREQ-1', description: 'Use an approved authorized test user.', status: 'available', evidenceIds: ['jira-QE-42'] }],
  ownedClarifications: [],
  phaseSpecificBlockers: [],
  proposedReadinessDecision: 'ready' as const,
  readinessDecision: 'ready' as const,
};

const profile = {
  codeAccessMode: 'read-only',
  frameworkConventions: ['BDD scenarios', 'page-object model for UI interactions'],
  dataRules: ['Use synthetic test data only.'],
  hardRules: ['Do not invent selectors, endpoints, or credentials.'],
};

function input(overrides: Partial<TestDesignInput> = {}): TestDesignInput {
  return {
    readinessPackage: basePackage,
    projectProfile: profile,
    ...overrides,
  };
}

describe('test design', () => {
  it('creates traceable BDD scenarios with explicit setup, data, and observables', () => {
    const design = buildTestDesign(input());

    expect(TestDesignSchema.parse(design)).toEqual(design);
    expect(design.storyKey).toBe('QE-42');
    expect(design.revision).toBe('rev-7');
    expect(design.strategy).toMatchObject({
      style: 'bdd',
      interactionModel: 'page-object',
      apiAgnostic: true,
    });
    expect(design.scenarios).toHaveLength(6);
    expect(design.scenarios).toEqual(expect.arrayContaining([
      expect.objectContaining({ category: 'positive', acceptanceCriteriaIds: ['AC-1'] }),
      expect.objectContaining({ category: 'positive', acceptanceCriteriaIds: ['AC-2'] }),
      expect.objectContaining({ category: 'negative', acceptanceCriteriaIds: ['AC-2'] }),
    ]));

    for (const scenario of design.scenarios) {
      expect(scenario.given.length).toBeGreaterThan(0);
      expect(scenario.when.length).toBeGreaterThan(0);
      expect(scenario.then.length).toBeGreaterThan(0);
      expect(scenario.setup.length).toBeGreaterThan(0);
      expect(scenario.data.length).toBeGreaterThan(0);
      expect(scenario.observables.length).toBeGreaterThan(0);
      expect(scenario.cleanup.length).toBeGreaterThan(0);
      expect(scenario.assumptions).toEqual([]);
      expect(scenario.evidenceIds.length).toBeGreaterThan(0);
    }
  });

  it('stops instead of designing from unresolved readiness or unsupported assumptions', () => {
    expect(() => buildTestDesign(input({
      readinessPackage: {
        ...basePackage,
        readinessDecision: 'needs-refinement',
        ownedClarifications: [{
          id: 'QUESTION-1',
          question: 'Which error contract is required?',
          owner: 'product',
          evidenceIds: ['jira-QE-42'],
        }],
      },
    }))).toThrow(/ready-for-design|readiness/i);

    const paused = buildTestDesign(input({
      readinessPackage: {
        ...basePackage,
        readinessDecision: 'ready',
        accessDataPrerequisites: [{
          id: 'PREREQ-1',
          description: 'Test data owner must provide an approved account.',
          status: 'unknown',
          evidenceIds: ['jira-QE-42'],
        }],
      },
      projectProfile: { codeAccessMode: 'read-only' },
    }));

    expect(paused.decision).toBe('waiting-for-human');
    expect(paused.humanDecision.questions).toEqual(expect.arrayContaining([
      expect.stringContaining('test data'),
      expect.stringContaining('convention'),
    ]));
    expect(paused.scenarios).toHaveLength(0);
  });

  it('does not guess a boundary or error case when the validated evidence does not describe one', () => {
    const design = buildTestDesign(input({
      readinessPackage: {
        ...basePackage,
        acceptanceCriteria: [basePackage.acceptanceCriteria[0]!],
        rtm: [basePackage.rtm[0]!],
      },
    }));

    expect(design.scenarios.map((scenario) => scenario.category)).not.toEqual(
      expect.arrayContaining(['boundary', 'error']),
    );
    expect(design.scenarios[0]?.when[0]).not.toMatch(/invalid|maximum|timeout/i);
  });
});
