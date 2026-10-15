import { describe, expect, it } from 'vitest';
import { InMemoryArtifactStore } from '../src/in-memory-stores.js';
import { publishReadinessHandoffArtifacts } from '../src/handoff-artifacts.js';

const traceId = '3d594650-3436-4d7c-86a7-2b94788009bc';
const createdAt = '2026-10-15T12:00:00.000Z';

function readinessPackage(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: '1.0', packageId: 'readiness:QE-42:1', revision: 'readiness-rev-1',
    component: 'membership-service', traceId, storyKey: 'QE-42', createdAt,
    provenance: { sources: [{ id: 'jira-QE-42', source: 'jira', revision: 'jira-r1', evidenceIds: ['story'] }] },
    acceptanceCriteria: [{ id: 'AC-1', statement: 'Inactive members are rejected.', evidenceIds: ['story'] }],
    confirmedFacts: [],
    historicalRelevance: [{ id: 'HISTORY-1', statement: 'Existing coverage is relevant.', relevance: 'supports', evidenceIds: ['story'] }],
    discrepancyRows: [{ id: 'DISCREPANCY-1', acId: 'AC-1', status: 'aligned', description: 'Behavior matches.', evidenceIds: ['story'] }],
    rtm: [{ id: 'RTM-1', acId: 'AC-1', expectedBehavior: 'The request is rejected.', observableOutcome: 'The response is HTTP 403.', verificationMethods: ['METHOD-1'], evidenceIds: ['story'] }],
    acVerificationMap: [{ acId: 'AC-1', expectedBehavior: 'The request is rejected.', observableOutcome: 'The response is HTTP 403.', verificationMethods: [{ id: 'METHOD-1', description: 'API contract test.', status: 'candidate', evidenceIds: ['story'] }], evidenceIds: ['story'] }],
    accessDataPrerequisites: [], ownedClarifications: [], phaseSpecificBlockers: [],
    proposedReadinessDecision: 'ready', readinessDecision: 'ready-for-design', ...overrides,
  };
}

describe('publishReadinessHandoffArtifacts', () => {
  it('publishes trace- and revision-linked discrepancy and RTM artifacts', async () => {
    const store = new InMemoryArtifactStore();

    const published = await publishReadinessHandoffArtifacts(readinessPackage(), store);

    expect(published.discrepancyReport).toMatchObject({
      id: 'discrepancy:QE-42:1', traceId, kind: 'requirement-analysis',
      content: {
        type: 'discrepancy-report', traceId, readinessPackageId: 'readiness:QE-42:1',
        readinessPackageRevision: 'readiness-rev-1',
        rows: [{ id: 'DISCREPANCY-1', classification: 'aligned', evidenceIds: ['story'] }],
      },
      metadata: { traceId, readinessPackageId: 'readiness:QE-42:1', readinessPackageRevision: 'readiness-rev-1' },
    });
    expect(published.traceabilityMatrix).toMatchObject({
      id: 'rtm:QE-42:1', traceId, kind: 'requirement-analysis',
      content: {
        type: 'traceability-matrix', traceId, readinessPackageId: 'readiness:QE-42:1',
        readinessPackageRevision: 'readiness-rev-1',
        rows: [{ id: 'RTM-1', acId: 'AC-1', expectedBehavior: 'The request is rejected.' }],
      },
    });
    expect(await store.get(published.discrepancyReport.id)).toEqual(published.discrepancyReport);
    expect(await store.get(published.traceabilityMatrix.id)).toEqual(published.traceabilityMatrix);
  });

  it('is idempotent for a package revision and refuses invalid packages before writing', async () => {
    const store = new InMemoryArtifactStore();
    const first = await publishReadinessHandoffArtifacts(readinessPackage(), store);
    const second = await publishReadinessHandoffArtifacts(readinessPackage(), store);

    expect(second).toEqual(first);
    expect(await store.listByTrace(traceId)).toHaveLength(2);
    await expect(publishReadinessHandoffArtifacts(readinessPackage({ revision: undefined }), store)).rejects.toThrow();
    expect(await store.listByTrace(traceId)).toHaveLength(2);
  });
});
