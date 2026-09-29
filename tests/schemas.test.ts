import { describe, expect, it } from 'vitest';
import {
  ArtifactRecordSchema,
  InvalidTransitionError,
  RecordIdSchema,
  RetryExhaustedError,
  WorkflowCancelledError,
  WorkflowStateSchema,
} from '../src/contracts.js';
import { QaPlanSchema, TestCaseSchema } from '../src/schemas.js';

describe('quality contracts', () => {
  it('accepts bounded Unicode record identifiers', () => {
    expect(RecordIdSchema.safeParse('é'.repeat(50)).success).toBe(true);
    expect(RecordIdSchema.safeParse('\u0800').success).toBe(true);
  });

  it('rejects unpaired surrogates and identifiers over 100 UTF-8 bytes', () => {
    for (const id of ['\uD800', '\uDC00', 'a'.repeat(101)]) {
      expect(RecordIdSchema.safeParse(id).success).toBe(false);
    }
  });

  it('applies record identifier validation to records and workflow artifact references', () => {
    const artifact = {
      id: '\uD800',
      traceId: '3d594650-3436-4d7c-86a7-2b94788009bc',
      kind: 'context-pack',
      schemaVersion: '1.0',
      createdAt: '2026-09-29T12:00:00.000Z',
      content: {},
      metadata: {},
    };
    const workflow = {
      id: 'story/QE-42',
      traceId: artifact.traceId,
      stage: 'refinement',
      status: 'pending',
      version: 0,
      updatedAt: artifact.createdAt,
      artifactIds: ['a'.repeat(101)],
      approval: { status: 'pending', reviewer: null, reviewedAt: null },
    };

    expect(ArtifactRecordSchema.safeParse(artifact).success).toBe(false);
    expect(WorkflowStateSchema.safeParse(workflow).success).toBe(false);
  });

  it('accepts a blocked workflow state', () => {
    const result = WorkflowStateSchema.safeParse({
      id: 'story/QE-42',
      traceId: '3d594650-3436-4d7c-86a7-2b94788009bc',
      stage: 'implementation',
      status: 'blocked',
      version: 1,
      updatedAt: '2026-09-29T12:00:00.000Z',
      artifactIds: [],
      approval: { status: 'not-required', reviewer: null, reviewedAt: null },
    });

    expect(result.success).toBe(true);
  });

  it('rejects test cases without observable expected results', () => {
    const result = TestCaseSchema.safeParse({
      id: 'TC-001',
      title: 'Login succeeds',
      layer: 'ui',
      priority: 'P0',
      preconditions: [],
      steps: ['Submit valid credentials'],
      expectedResults: [],
      automationCandidate: true,
      rationale: 'Critical journey',
    });
    expect(result.success).toBe(false);
  });

  it('defaults to a pending human decision in a valid draft', () => {
    const result = QaPlanSchema.safeParse({
      schemaVersion: '1.0',
      createdAt: new Date().toISOString(),
      requirement: 'A user can sign in.',
      analysis: {
        feature: 'Sign in',
        actors: ['user'],
        businessRules: ['Valid credentials grant access'],
        assumptions: [],
        openQuestions: [],
        risks: [{ area: 'authentication', severity: 'high', rationale: 'Controls account access' }],
      },
      design: {
        strategy: 'API-first with one UI journey',
        testCases: [1, 2, 3].map((id) => ({
          id: `TC-00${id}`,
          title: `Scenario ${id}`,
          layer: id === 3 ? 'ui' : 'api',
          priority: 'P1',
          preconditions: [],
          steps: ['Submit request'],
          expectedResults: ['Result is observable'],
          automationCandidate: true,
          rationale: 'Risk coverage',
        })),
        outOfScope: [],
        requiredTestData: ['valid user'],
      },
      agentReview: {
        verdict: 'approve',
        score: 90,
        findings: [],
        missingCoverage: [],
        reviewSummary: 'Actionable draft',
      },
      humanReview: {
        status: 'pending',
        reviewer: null,
        reviewedAt: null,
        notes: 'Awaiting review',
      },
    });

    expect(result.success).toBe(true);
    if (result.success) expect(result.data.humanReview.status).toBe('pending');
  });
});

describe('workflow lifecycle errors', () => {
  it('describes an invalid transition', () => {
    const error = new InvalidTransitionError('planning', 'production');

    expect(error).toBeInstanceOf(InvalidTransitionError);
    expect(error.name).toBe('InvalidTransitionError');
    expect(error.message).toBe("Workflow cannot transition from 'planning' to 'production'.");
  });

  it('describes a cancelled workflow', () => {
    const error = new WorkflowCancelledError('workflow-42');

    expect(error).toBeInstanceOf(WorkflowCancelledError);
    expect(error.name).toBe('WorkflowCancelledError');
    expect(error.message).toBe("Workflow 'workflow-42' was cancelled.");
  });

  it('describes exhausted retries and preserves the cause', () => {
    const cause = new Error('provider unavailable');
    const error = new RetryExhaustedError('workflow-42', 3, { cause });

    expect(error).toBeInstanceOf(RetryExhaustedError);
    expect(error.name).toBe('RetryExhaustedError');
    expect(error.message).toBe("Workflow 'workflow-42' exhausted 3 attempts.");
    expect(error.cause).toBe(cause);
  });
});
