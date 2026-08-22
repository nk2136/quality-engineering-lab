import { describe, expect, it } from 'vitest';
import { QaPlanSchema, TestCaseSchema } from '../src/schemas.js';

describe('quality contracts', () => {
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
