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

const ReadinessEvidenceReferenceSchema = z.object({
  evidenceIds: z.array(z.string().trim().min(1)).min(1),
});

const ReadinessSourceSchema = z.object({
  id: z.string().trim().min(1),
  source: z.string().trim().min(1),
  revision: z.string().trim().min(1),
  evidenceIds: z.array(z.string().trim().min(1)).min(1),
});

const ReadinessAcceptanceCriterionSchema = ReadinessEvidenceReferenceSchema.extend({
  id: z.string().regex(/^AC-\d+$/),
  statement: z.string().min(1),
});

const ReadinessFactSchema = ReadinessEvidenceReferenceSchema.extend({
  id: z.string().regex(/^FACT-\d+$/),
  statement: z.string().min(1),
});

const HistoricalRelevanceSchema = ReadinessEvidenceReferenceSchema.extend({
  id: z.string().regex(/^HISTORY-\d+$/),
  statement: z.string().min(1),
  relevance: z.string().trim().min(1),
});

const VerificationMethodSchema = ReadinessEvidenceReferenceSchema.extend({
  id: z.string().regex(/^METHOD-\d+$/),
  description: z.string().min(1),
  status: z.enum(['candidate', 'confirmed']),
});

const AcceptanceVerificationSchema = ReadinessEvidenceReferenceSchema.extend({
  acId: z.string().regex(/^AC-\d+$/),
  expectedBehavior: z.string().min(1),
  observableOutcome: z.string().min(1),
  verificationMethods: z.array(VerificationMethodSchema).min(1),
});

const ReadinessPrerequisiteSchema = ReadinessEvidenceReferenceSchema.extend({
  id: z.string().regex(/^PREREQ-\d+$/),
  description: z.string().min(1),
  status: z.enum(['available', 'missing', 'unknown']),
});

const ReadinessClarificationSchema = ReadinessEvidenceReferenceSchema.extend({
  id: z.string().regex(/^QUESTION-\d+$/),
  question: z.string().min(1),
  owner: z.string().trim().min(1),
});

const ReadinessBlockerSchema = ReadinessEvidenceReferenceSchema.extend({
  id: z.string().regex(/^BLOCKER-\d+$/),
  phase: z.string().min(1),
  description: z.string().min(1),
});

const DiscrepancyClassificationSchema = z.enum(['aligned', 'extra', 'missing', 'conflict', 'silent']);

const ReadinessDiscrepancySchema = ReadinessEvidenceReferenceSchema.extend({
  id: z.string().regex(/^(?:DISCREPANCY|DISC)-\d+$/),
  acId: z.string().regex(/^AC-\d+$/).optional(),
  classification: DiscrepancyClassificationSchema.optional(),
  // `status` is accepted as a wire-compatible spelling for older producers.
  status: DiscrepancyClassificationSchema.optional(),
  description: z.string().min(1),
}).superRefine((row, context) => {
  if (row.classification === undefined && row.status === undefined) {
    context.addIssue({ code: 'custom', path: ['classification'], message: 'A discrepancy row must declare a classification.' });
  }
  if (row.classification !== undefined && row.status !== undefined && row.classification !== row.status) {
    context.addIssue({ code: 'custom', path: ['status'], message: 'Discrepancy classification and status must agree.' });
  }
});

const ReadinessRtmMethodSchema = z.union([
  z.string().trim().min(1),
  VerificationMethodSchema,
]);

const ReadinessRtmRowSchema = ReadinessEvidenceReferenceSchema.extend({
  id: z.string().regex(/^RTM-\d+$/),
  acId: z.string().regex(/^AC-\d+$/),
  expectedBehavior: z.string().min(1),
  observableOutcome: z.string().min(1),
  verificationMethods: z.array(ReadinessRtmMethodSchema).min(1),
});

const ReadinessDecisionSchema = z.enum([
  'ready',
  'ready-for-design',
  'needs-refinement',
  'blocked',
  'not-ready',
]);

export const ReadinessPackageSchema = z.object({
  schemaVersion: z.literal('1.0'),
  packageId: z.string().min(1),
  revision: z.string().trim().min(1),
  component: z.string().trim().min(1),
  traceId: z.string().uuid(),
  storyKey: z.string().regex(/^[A-Z][A-Z0-9_]*-\d+$/),
  createdAt: z.string().datetime(),
  provenance: z.object({
    sources: z.array(ReadinessSourceSchema).min(1),
  }),
  acceptanceCriteria: z.array(ReadinessAcceptanceCriterionSchema).min(1),
  confirmedFacts: z.array(ReadinessFactSchema),
  historicalRelevance: z.array(HistoricalRelevanceSchema).min(1),
  discrepancyRows: z.array(ReadinessDiscrepancySchema).optional(),
  discrepancies: z.array(ReadinessDiscrepancySchema).optional(),
  discrepancyReport: z.array(ReadinessDiscrepancySchema).optional(),
  rtm: z.array(ReadinessRtmRowSchema).optional(),
  requirementsTraceabilityMatrix: z.array(ReadinessRtmRowSchema).optional(),
  traceabilityMatrix: z.array(ReadinessRtmRowSchema).optional(),
  acVerificationMap: z.array(AcceptanceVerificationSchema).optional(),
  accessDataPrerequisites: z.array(ReadinessPrerequisiteSchema),
  ownedClarifications: z.array(ReadinessClarificationSchema),
  phaseSpecificBlockers: z.array(ReadinessBlockerSchema),
  proposedReadinessDecision: ReadinessDecisionSchema.optional(),
  readinessDecision: ReadinessDecisionSchema.optional(),
  readyForDesignDecision: ReadinessDecisionSchema.optional(),
}).superRefine((packageValue, context) => {
  if (
    packageValue.discrepancyRows === undefined &&
    packageValue.discrepancies === undefined &&
    packageValue.discrepancyReport === undefined
  ) {
    context.addIssue({ code: 'custom', path: ['discrepancyRows'], message: 'A readiness package must include discrepancy rows.' });
  }
  if (
    packageValue.rtm === undefined &&
    packageValue.requirementsTraceabilityMatrix === undefined &&
    packageValue.traceabilityMatrix === undefined
  ) {
    context.addIssue({ code: 'custom', path: ['rtm'], message: 'A readiness package must include an RTM.' });
  }
  if (
    packageValue.acVerificationMap === undefined &&
    packageValue.rtm === undefined &&
    packageValue.requirementsTraceabilityMatrix === undefined &&
    packageValue.traceabilityMatrix === undefined
  ) {
    context.addIssue({ code: 'custom', path: ['acVerificationMap'], message: 'A readiness package must include AC verification mappings.' });
  }
  if (
    packageValue.proposedReadinessDecision === undefined &&
    packageValue.readinessDecision === undefined &&
    packageValue.readyForDesignDecision === undefined
  ) {
    context.addIssue({ code: 'custom', path: ['readinessDecision'], message: 'A readiness package must include a design-readiness decision.' });
  }
  if (
    packageValue.proposedReadinessDecision !== undefined &&
    packageValue.readinessDecision !== undefined &&
    !(
      packageValue.proposedReadinessDecision === packageValue.readinessDecision ||
      (packageValue.proposedReadinessDecision === 'ready' && packageValue.readinessDecision === 'ready-for-design') ||
      (packageValue.proposedReadinessDecision === 'ready-for-design' && packageValue.readinessDecision === 'ready')
    )
  ) {
    context.addIssue({ code: 'custom', path: ['readinessDecision'], message: 'Readiness decisions must agree.' });
  }
  const decisions = [
    packageValue.proposedReadinessDecision,
    packageValue.readinessDecision,
    packageValue.readyForDesignDecision,
  ].filter((value): value is z.infer<typeof ReadinessDecisionSchema> => value !== undefined)
    .map((value) => value === 'ready' ? 'ready-for-design' : value);
  if (new Set(decisions).size > 1) {
    context.addIssue({ code: 'custom', path: ['readyForDesignDecision'], message: 'Readiness decisions must agree.' });
  }
});

export type RequirementAnalysis = z.infer<typeof RequirementAnalysisSchema>;
export type TestDesign = z.infer<typeof TestDesignSchema>;
export type ReviewVerdict = z.infer<typeof ReviewVerdictSchema>;
export type QaPlan = z.infer<typeof QaPlanSchema>;
export type FailureTriage = z.infer<typeof FailureTriageSchema>;
export type ReadinessPackage = z.infer<typeof ReadinessPackageSchema>;
