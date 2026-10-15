import { describe, expect, it } from 'vitest';
import { reviewTestDesign, TestDesignReviewSchema } from '../src/test-design-review.js';

const readiness = {
  packageId: 'readiness:QE-42:rev-7',
  storyKey: 'QE-42',
  revision: 'rev-7',
  component: 'membership-service',
  readinessDecision: 'ready',
  acceptanceCriteria: [
    { id: 'AC-1', statement: 'Critical members can submit a request.', priority: 'P0', evidenceIds: ['E-1'] },
  ],
  rtm: [{ id: 'RTM-1', acId: 'AC-1', observableOutcome: 'A request is created.', evidenceIds: ['E-1'] }],
  provenance: { sources: [{ id: 'E-1', revision: 'rev-7' }] },
  phaseSpecificBlockers: [],
};

function scenario(id: string, category: string, overrides: Record<string, unknown> = {}) {
  return { id, category, acceptanceCriteriaIds: ['AC-1'], evidenceIds: ['E-1'], ...overrides };
}

describe('reviewTestDesign', () => {
  it('approves complete critical coverage and routes it to implementation', () => {
    const result = reviewTestDesign({
      readinessPackage: readiness,
      design: {
        rtm: [{ id: 'RTM-1', acId: 'AC-1', scenarioIds: ['SCENARIO-001', 'SCENARIO-002', 'SCENARIO-003', 'SCENARIO-004'], evidenceIds: ['E-1'] }],
        scenarios: [
          scenario('SCENARIO-001', 'positive'),
          scenario('SCENARIO-002', 'negative'),
          scenario('SCENARIO-003', 'boundary'),
          scenario('SCENARIO-004', 'error'),
        ],
      },
    });

    expect(TestDesignReviewSchema.parse(result)).toEqual(result);
    expect(result.verdict).toBe('approve');
    expect(result.nextStage).toBe('implementation');
    expect(result.findings).toEqual([]);
  });

  it('rejects a critical acceptance criterion with missing risk categories', () => {
    const result = reviewTestDesign({
      readinessPackage: readiness,
      design: { scenarios: [scenario('SCENARIO-001', 'positive')] },
    });

    expect(result.verdict).toBe('reject');
    expect(result.nextStage).toBe('planning');
    expect(result.missingCoverage).toEqual(['AC-1:negative', 'AC-1:boundary', 'AC-1:error']);
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ category: 'coverage', scenarioIds: ['SCENARIO-001'], evidenceIds: ['E-1'] }),
    ]));
  });

  it('reports duplicate IDs, unsupported assumptions, unknown evidence, and flakiness', () => {
    const result = reviewTestDesign({
      readinessPackage: readiness,
      design: {
        scenarios: [
          scenario('SCENARIO-001', 'positive', { assumptions: ['A production account exists'], evidenceIds: ['E-1'] }),
          scenario('SCENARIO-001', 'negative', { evidenceIds: ['E-unknown'], when: ['wait for 10 seconds'] }),
        ],
      },
    });

    expect(result.verdict).toBe('reject');
    expect(result.nextStage).toBe('planning');
    expect(result.findings.map((finding) => finding.category)).toEqual(expect.arrayContaining([
      'duplicate', 'assumption', 'traceability', 'flakiness', 'coverage',
    ]));
  });

  it('rejects unresolved readiness blockers and incomplete design RTM mappings', () => {
    const result = reviewTestDesign({
      readinessPackage: {
        ...readiness,
        phaseSpecificBlockers: [{ id: 'BLOCKER-1', description: 'Test data owner is unknown.', evidenceIds: ['E-1'] }],
      },
      design: {
        rtm: [{ id: 'RTM-1', acId: 'AC-MISSING', scenarioIds: ['SCENARIO-001'], evidenceIds: ['E-1'] }],
        scenarios: [scenario('SCENARIO-001', 'positive')],
      },
    });

    expect(result.verdict).toBe('reject');
    expect(result.nextStage).toBe('planning');
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ category: 'blocker', severity: 'blocking', evidenceIds: ['E-1'] }),
      expect.objectContaining({ category: 'traceability', severity: 'blocking' }),
    ]));
  });
});
