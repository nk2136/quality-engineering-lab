import { z } from 'zod';
import type { ContextPack } from './context.js';

export const FindingSeveritySchema = z.enum(['minor', 'major', 'blocking']);

export const FindingBasisSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('evidence'),
    evidenceIds: z.array(z.string().min(1)).min(1),
  }),
  z.object({
    kind: z.literal('missing-evidence'),
    missingEvidence: z.string().min(1),
  }),
  z.object({
    kind: z.literal('contradiction'),
    contradiction: z.string().min(1),
  }),
]);

export const ReadinessFindingSchema = z.object({
  id: z.string().regex(/^FINDING-\d{3}$/),
  category: z.enum([
    'acceptance-criteria',
    'business-rule',
    'dependency',
    'architecture',
    'testability',
    'security',
    'operability',
  ]),
  severity: FindingSeveritySchema,
  summary: z.string().min(1),
  impact: z.string().min(1),
  basis: FindingBasisSchema,
});

export const RefinementQuestionSchema = z.object({
  question: z.string().min(1),
  resolvesFindingIds: z.array(z.string().regex(/^FINDING-\d{3}$/)).min(1),
});

export const StoryReadinessDraftSchema = z.object({
  storyKey: z.string().regex(/^[A-Z][A-Z0-9_]*-\d+$/),
  summary: z.string().min(1),
  findings: z.array(ReadinessFindingSchema),
  refinementQuestions: z.array(RefinementQuestionSchema),
  suggestedAcceptanceCriteria: z.array(z.string().min(1)),
  recommendedTestLayers: z.array(
    z.enum(['unit', 'contract', 'api', 'integration', 'ui', 'performance', 'security', 'accessibility']),
  ),
});

export const StoryReadinessAssessmentSchema = StoryReadinessDraftSchema.extend({
  schemaVersion: z.literal('1.0'),
  traceId: z.string().uuid(),
  readinessScore: z.number().int().min(0).max(100),
  decision: z.enum(['ready', 'needs-refinement', 'blocked']),
  humanReview: z.object({
    status: z.literal('pending'),
    reviewer: z.null(),
    reviewedAt: z.null(),
  }),
});

export type StoryReadinessDraft = z.infer<typeof StoryReadinessDraftSchema>;
export type StoryReadinessAssessment = z.infer<typeof StoryReadinessAssessmentSchema>;

const severityDeductions = {
  minor: 5,
  major: 15,
  blocking: 30,
} as const;

function validateReferences(draft: StoryReadinessDraft, contextPack: ContextPack): void {
  const evidenceIds = new Set(contextPack.evidence.map((evidence) => evidence.id));
  const missingEvidence = new Set(contextPack.missingEvidence);
  const contradictions = new Set(contextPack.contradictions);
  const findingIds = new Set(draft.findings.map((finding) => finding.id));

  if (findingIds.size !== draft.findings.length) {
    throw new Error('Finding IDs must be unique.');
  }

  for (const finding of draft.findings) {
    if (finding.basis.kind === 'evidence') {
      const unknown = finding.basis.evidenceIds.filter((id) => !evidenceIds.has(id));
      if (unknown.length > 0) {
        throw new Error(`Finding '${finding.id}' cites unknown evidence: ${unknown.join(', ')}.`);
      }
    } else if (finding.basis.kind === 'missing-evidence') {
      if (!missingEvidence.has(finding.basis.missingEvidence)) {
        throw new Error(`Finding '${finding.id}' references undocumented missing evidence.`);
      }
    } else if (!contradictions.has(finding.basis.contradiction)) {
      throw new Error(`Finding '${finding.id}' references an undocumented contradiction.`);
    }
  }

  for (const question of draft.refinementQuestions) {
    const unknown = question.resolvesFindingIds.filter((id) => !findingIds.has(id));
    if (unknown.length > 0) {
      throw new Error(`Refinement question references unknown findings: ${unknown.join(', ')}.`);
    }
  }
}

function calculateReadiness(findings: StoryReadinessDraft['findings']): {
  readinessScore: number;
  decision: StoryReadinessAssessment['decision'];
} {
  const deduction = findings.reduce(
    (total, finding) => total + severityDeductions[finding.severity],
    0,
  );
  const readinessScore = Math.max(0, 100 - deduction);
  const hasBlockingFinding = findings.some((finding) => finding.severity === 'blocking');
  const hasMajorFinding = findings.some((finding) => finding.severity === 'major');
  const decision = hasBlockingFinding
    ? 'blocked'
    : readinessScore >= 80 && !hasMajorFinding
      ? 'ready'
      : 'needs-refinement';

  return { readinessScore, decision };
}

/**
 * Converts a model-produced draft into an auditable assessment. Scores and
 * decisions are deterministic; the model cannot set or override either value.
 */
export function finalizeStoryReadiness(
  draftInput: StoryReadinessDraft,
  contextPack: ContextPack,
): StoryReadinessAssessment {
  const draft = StoryReadinessDraftSchema.parse(draftInput);
  validateReferences(draft, contextPack);
  const readiness = calculateReadiness(draft.findings);

  return StoryReadinessAssessmentSchema.parse({
    ...draft,
    schemaVersion: '1.0',
    traceId: contextPack.traceId,
    ...readiness,
    humanReview: {
      status: 'pending',
      reviewer: null,
      reviewedAt: null,
    },
  });
}
