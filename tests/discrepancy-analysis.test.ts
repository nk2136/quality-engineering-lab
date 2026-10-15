import { describe, expect, it } from 'vitest';
import {
  buildDiscrepancyAnalysis,
  generateRequirementsTraceabilityMatrix,
} from '../src/discrepancy-analysis.js';

const baseInput = {
  storyKey: 'QE-42',
  traceId: '3d594650-3436-4d7c-86a7-2b94788009bc',
  revision: 'readiness-rev-1',
  generatedAt: '2026-10-15T12:00:00.000Z',
  acceptanceCriteria: [
    { id: 'AC-1', statement: 'Inactive members are rejected.', evidenceIds: ['jira-QE-42'] },
    { id: 'AC-2', statement: 'The rejection is auditable.', evidenceIds: ['jira-QE-42'] },
  ],
  implementation: [
    { id: 'impl-1', acId: 'AC-1', description: 'Membership policy returns forbidden.' },
    { id: 'impl-2', acId: 'AC-2', description: 'Audit event is emitted.' },
  ],
  existingCoverage: [
    {
      id: 'test-1',
      acId: 'AC-1',
      description: 'API test asserts HTTP 403 for an inactive member.',
      observedOutcome: 'HTTP 403 is returned.',
      evidenceIds: ['test-1'],
    },
  ],
  evidence: [
    { id: 'jira-QE-42', source: 'jira', revision: 'jira-rev-7' },
    { id: 'test-1', source: 'test', revision: 'tests-rev-4' },
    { id: 'impl-1', source: 'github', revision: 'code-rev-8' },
    { id: 'impl-2', source: 'github', revision: 'code-rev-8' },
    { id: 'extra-1', source: 'test', revision: 'tests-rev-4', description: 'Legacy health check.' },
  ],
};

describe('discrepancy analysis', () => {
  it('classifies aligned, missing, extra, conflict, and silent observations', () => {
    const report = buildDiscrepancyAnalysis({
      ...baseInput,
      acceptanceCriteria: [
        ...baseInput.acceptanceCriteria,
        { id: 'AC-3', statement: 'The event is delivered exactly once.', evidenceIds: ['jira-QE-42'] },
        { id: 'AC-4', statement: 'The event has a stable ordering.', evidenceIds: ['jira-QE-42'] },
      ],
      implementation: [
        ...baseInput.implementation,
        { id: 'impl-3', acId: 'AC-3', description: 'Event publisher retries delivery.' },
        { id: 'impl-4', acId: 'AC-4', description: 'Events are queued without an ordering guarantee.' },
      ],
      existingCoverage: [
        ...baseInput.existingCoverage,
        {
          id: 'test-3',
          acId: 'AC-3',
          description: 'Duplicate delivery is not asserted.',
          observedOutcome: 'silent',
          evidenceIds: ['test-3'],
        },
        {
          id: 'test-4',
          acId: 'AC-4',
          description: 'Test expects ordered events but implementation does not guarantee order.',
          classification: 'conflict',
          evidenceIds: ['test-4'],
        },
      ],
      evidence: [
        ...baseInput.evidence,
        { id: 'test-3', source: 'test', revision: 'tests-rev-4' },
        { id: 'test-4', source: 'test', revision: 'tests-rev-4' },
      ],
    });

    expect(report.discrepancyRows).toEqual(expect.arrayContaining([
      expect.objectContaining({ acId: 'AC-1', classification: 'aligned' }),
      expect.objectContaining({ acId: 'AC-2', classification: 'missing' }),
      expect.objectContaining({ acId: 'AC-3', classification: 'silent' }),
      expect.objectContaining({ acId: 'AC-4', classification: 'conflict' }),
      expect.objectContaining({ classification: 'extra', evidenceIds: ['extra-1'] }),
    ]));
  });

  it('generates applicable positive, negative, boundary, and error coverage requirements', () => {
    const report = buildDiscrepancyAnalysis({
      ...baseInput,
      acceptanceCriteria: [{
        id: 'AC-1',
        statement: 'Reject invalid values above the maximum and return a validation error.',
        evidenceIds: ['jira-QE-42'],
      }],
    });

    expect(report.coverageRequirements).toEqual(expect.arrayContaining([
      expect.objectContaining({ acId: 'AC-1', category: 'positive', required: true }),
      expect.objectContaining({ acId: 'AC-1', category: 'negative', required: true }),
      expect.objectContaining({ acId: 'AC-1', category: 'boundary', required: true }),
      expect.objectContaining({ acId: 'AC-1', category: 'data-validation', required: true }),
      expect.objectContaining({ acId: 'AC-1', category: 'error', required: true }),
    ]));
  });

  it('returns a durable artifact-ready report and RTM with revision-bound evidence', () => {
    const report = buildDiscrepancyAnalysis(baseInput);
    const rtm = generateRequirementsTraceabilityMatrix(baseInput);

    expect(report).toMatchObject({
      schemaVersion: '1.0',
      artifactKind: 'discrepancy-analysis',
      storyKey: 'QE-42',
      revision: 'readiness-rev-1',
      artifact: expect.objectContaining({
        id: 'discrepancy-analysis:QE-42:readiness-rev-1',
        traceId: baseInput.traceId,
        content: expect.objectContaining({ storyKey: 'QE-42' }),
      }),
    });
    expect(rtm).toHaveLength(2);
    expect(rtm[0]).toMatchObject({
      id: 'RTM-001',
      acId: 'AC-1',
      expectedBehavior: 'Inactive members are rejected.',
      verificationMethods: expect.arrayContaining([expect.stringContaining('test-1')]),
    });
  });
});
