import { z } from 'zod';

export const RiskSchema = z.object({
  area: z.string().min(1),
  severity: z.enum(['low', 'medium', 'high', 'critical']),
  rationale: z.string().min(1),
});

export const RequirementAnalysisSchema = z.object({
  feature: z.string().min(1),
  actors: z.array(z.string().min(1)).min(1),
  businessRules: z.array(z.string().min(1)).min(1),
  assumptions: z.array(z.string().min(1)),
  openQuestions: z.array(z.string().min(1)),
  risks: z.array(RiskSchema).min(1),
});

export const TestCaseSchema = z.object({
  id: z.string().regex(/^TC-\d{3}$/),
  title: z.string().min(1),
  layer: z.enum(['unit', 'api', 'integration', 'ui', 'contract', 'performance', 'security', 'accessibility']),
  priority: z.enum(['P0', 'P1', 'P2', 'P3']),
  preconditions: z.array(z.string().min(1)),
  steps: z.array(z.string().min(1)).min(1),
  expectedResults: z.array(z.string().min(1)).min(1),
  automationCandidate: z.boolean(),
  rationale: z.string().min(1),
});

export const TestDesignSchema = z.object({
  strategy: z.string().min(1),
  testCases: z.array(TestCaseSchema).min(3),
  outOfScope: z.array(z.string().min(1)),
  requiredTestData: z.array(z.string().min(1)),
});

export const ReviewFindingSchema = z.object({
  severity: z.enum(['info', 'warning', 'blocking']),
  category: z.enum(['coverage', 'assertion', 'test-data', 'maintainability', 'security', 'ambiguity']),
  message: z.string().min(1),
  recommendation: z.string().min(1),
});

export const ReviewVerdictSchema = z.object({
  verdict: z.enum(['approve', 'revise', 'reject']),
  score: z.number().int().min(0).max(100),
  findings: z.array(ReviewFindingSchema),
  missingCoverage: z.array(z.string().min(1)),
  reviewSummary: z.string().min(1),
});

export const QaPlanSchema = z.object({
  schemaVersion: z.literal('1.0'),
  createdAt: z.string().datetime(),
  requirement: z.string().min(1),
  analysis: RequirementAnalysisSchema,
  design: TestDesignSchema,
  agentReview: ReviewVerdictSchema,
  humanReview: z.object({
    status: z.enum(['pending', 'approved', 'rejected']),
    reviewer: z.string().nullable(),
    reviewedAt: z.string().datetime().nullable(),
    notes: z.string(),
  }),
});

export const FailureTriageSchema = z.object({
  summary: z.string().min(1),
  likelyCategory: z.enum(['product-defect', 'test-defect', 'environment', 'test-data', 'flaky', 'unknown']),
  confidence: z.number().min(0).max(1),
  evidence: z.array(z.string().min(1)).min(1),
  nextActions: z.array(z.string().min(1)).min(1),
  needsHumanReview: z.boolean(),
});

export type RequirementAnalysis = z.infer<typeof RequirementAnalysisSchema>;
export type TestDesign = z.infer<typeof TestDesignSchema>;
export type ReviewVerdict = z.infer<typeof ReviewVerdictSchema>;
export type QaPlan = z.infer<typeof QaPlanSchema>;
export type FailureTriage = z.infer<typeof FailureTriageSchema>;
