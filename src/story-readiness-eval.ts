import { z } from 'zod';
import { EvidenceSourceSchema } from './context.js';
import {
  FindingSeveritySchema,
  StoryReadinessAssessmentSchema,
} from './story-readiness.js';

const GapExpectationSchema = z.object({
  id: z.string().min(1),
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
  terms: z.array(z.string().min(1)).min(1),
});

export const StoryReadinessGoldenCaseSchema = z.object({
  schemaVersion: z.literal('1.0'),
  id: z.string().min(1),
  storyKey: z.string().regex(/^[A-Z][A-Z0-9_]*-\d+$/),
  requirement: z.string().min(1),
  evidence: z.array(
    z.object({
      id: z.string().min(1),
      source: EvidenceSourceSchema,
      content: z.string().min(1),
    }),
  ).min(1),
  allowedMissingEvidence: z.array(z.string().min(1)),
  allowedContradictions: z.array(z.string().min(1)),
  expectedDecision: z.enum(['ready', 'needs-refinement', 'blocked']),
  expectedGaps: z.array(GapExpectationSchema),
  thresholds: z.object({
    minimumGapRecall: z.number().min(0).max(1),
    minimumCitationFaithfulness: z.number().min(0).max(1),
  }),
});

export const StoryReadinessEvalReportSchema = z.object({
  caseId: z.string().min(1),
  passed: z.boolean(),
  decisionAgreement: z.boolean(),
  gapRecall: z.number().min(0).max(1),
  citationFaithfulness: z.number().min(0).max(1),
  matchedGapIds: z.array(z.string().min(1)),
  missingGapIds: z.array(z.string().min(1)),
  invalidFindingIds: z.array(z.string().min(1)),
});

export type StoryReadinessGoldenCase = z.infer<typeof StoryReadinessGoldenCaseSchema>;
export type StoryReadinessEvalReport = z.infer<typeof StoryReadinessEvalReportSchema>;

function normalize(value: string): string {
  return value.toLocaleLowerCase('en-US').replace(/\s+/g, ' ').trim();
}

function findingIsFaithful(
  finding: z.infer<typeof StoryReadinessAssessmentSchema>['findings'][number],
  goldenCase: StoryReadinessGoldenCase,
): boolean {
  if (finding.basis.kind === 'evidence') {
    const allowed = new Set(goldenCase.evidence.map((item) => item.id));
    return finding.basis.evidenceIds.every((id) => allowed.has(id));
  }
  if (finding.basis.kind === 'missing-evidence') {
    return goldenCase.allowedMissingEvidence.includes(finding.basis.missingEvidence);
  }
  return goldenCase.allowedContradictions.includes(finding.basis.contradiction);
}

/**
 * Scores one validated assessment against a human-authored golden case. Gap
 * expectations are greedily matched one-to-one so one broad finding cannot
 * receive credit for multiple expected gaps.
 */
export function evaluateStoryReadiness(
  assessmentValue: unknown,
  goldenCaseValue: unknown,
): StoryReadinessEvalReport {
  const assessment = StoryReadinessAssessmentSchema.parse(assessmentValue);
  const goldenCase = StoryReadinessGoldenCaseSchema.parse(goldenCaseValue);
  const unusedFindingIndexes = new Set(assessment.findings.map((_, index) => index));
  const matchedGapIds: string[] = [];
  const missingGapIds: string[] = [];

  for (const expected of goldenCase.expectedGaps) {
    const matchIndex = [...unusedFindingIndexes].find((index) => {
      const finding = assessment.findings[index];
      if (finding === undefined) return false;
      const text = normalize(`${finding.summary} ${finding.impact}`);
      return (
        finding.category === expected.category &&
        finding.severity === expected.severity &&
        expected.terms.every((term) => text.includes(normalize(term)))
      );
    });

    if (matchIndex === undefined) {
      missingGapIds.push(expected.id);
    } else {
      unusedFindingIndexes.delete(matchIndex);
      matchedGapIds.push(expected.id);
    }
  }

  const invalidFindingIds = assessment.findings
    .filter((finding) => !findingIsFaithful(finding, goldenCase))
    .map((finding) => finding.id);
  const gapRecall = goldenCase.expectedGaps.length === 0
    ? 1
    : matchedGapIds.length / goldenCase.expectedGaps.length;
  const citationFaithfulness = assessment.findings.length === 0
    ? 1
    : (assessment.findings.length - invalidFindingIds.length) / assessment.findings.length;
  const decisionAgreement = assessment.decision === goldenCase.expectedDecision;
  const passed =
    decisionAgreement &&
    gapRecall >= goldenCase.thresholds.minimumGapRecall &&
    citationFaithfulness >= goldenCase.thresholds.minimumCitationFaithfulness;

  return StoryReadinessEvalReportSchema.parse({
    caseId: goldenCase.id,
    passed,
    decisionAgreement,
    gapRecall,
    citationFaithfulness,
    matchedGapIds,
    missingGapIds,
    invalidFindingIds,
  });
}
