import { z } from 'zod';
import { ContextEvidenceSchema, EvidenceSourceSchema } from './context.js';

export const KnowledgeRetrievalGoldenCaseSchema = z
  .object({
    schemaVersion: z.literal('1.0'),
    id: z.string().min(1),
    query: z.string().min(1),
    expectedRelevantEvidenceIds: z.array(z.string().min(1)).min(1),
    requiredSources: z.array(EvidenceSourceSchema).min(1),
    thresholds: z.object({
      k: z.number().int().positive(),
      minimumRecallAtK: z.number().min(0).max(1),
      minimumPrecisionAtK: z.number().min(0).max(1),
      minimumReciprocalRank: z.number().min(0).max(1),
      minimumSourceCoverage: z.number().min(0).max(1),
    }),
  })
  .superRefine((value, context) => {
    if (new Set(value.expectedRelevantEvidenceIds).size !== value.expectedRelevantEvidenceIds.length) {
      context.addIssue({
        code: 'custom',
        path: ['expectedRelevantEvidenceIds'],
        message: 'Expected relevant evidence IDs must be unique.',
      });
    }
    if (new Set(value.requiredSources).size !== value.requiredSources.length) {
      context.addIssue({
        code: 'custom',
        path: ['requiredSources'],
        message: 'Required sources must be unique.',
      });
    }
  });

export const KnowledgeRetrievalEvalReportSchema = z.object({
  caseId: z.string().min(1),
  passed: z.boolean(),
  k: z.number().int().positive(),
  recallAtK: z.number().min(0).max(1),
  precisionAtK: z.number().min(0).max(1),
  reciprocalRank: z.number().min(0).max(1),
  sourceCoverage: z.number().min(0).max(1),
  matchedEvidenceIds: z.array(z.string().min(1)),
  missingEvidenceIds: z.array(z.string().min(1)),
  unexpectedEvidenceIds: z.array(z.string().min(1)),
  missingSources: z.array(EvidenceSourceSchema),
  duplicateEvidenceIds: z.array(z.string().min(1)),
});

export type KnowledgeRetrievalGoldenCase = z.infer<typeof KnowledgeRetrievalGoldenCaseSchema>;
export type KnowledgeRetrievalEvalReport = z.infer<typeof KnowledgeRetrievalEvalReportSchema>;

/**
 * Measures a deterministic ranked evidence list against a human-authored
 * retrieval expectation. Duplicate results fail even if headline metrics pass.
 */
export function evaluateKnowledgeRetrieval(
  evidenceValue: unknown,
  goldenCaseValue: unknown,
): KnowledgeRetrievalEvalReport {
  const evidence = z.array(ContextEvidenceSchema).parse(evidenceValue);
  const goldenCase = KnowledgeRetrievalGoldenCaseSchema.parse(goldenCaseValue);
  const topK = evidence.slice(0, goldenCase.thresholds.k);
  const expectedIds = new Set(goldenCase.expectedRelevantEvidenceIds);
  const matchedEvidenceIds = topK
    .filter((item) => expectedIds.has(item.id))
    .map((item) => item.id);
  const matchedUniqueIds = new Set(matchedEvidenceIds);
  const missingEvidenceIds = goldenCase.expectedRelevantEvidenceIds
    .filter((id) => !matchedUniqueIds.has(id));
  const unexpectedEvidenceIds = topK
    .filter((item) => !expectedIds.has(item.id))
    .map((item) => item.id);
  const firstRelevantIndex = topK.findIndex((item) => expectedIds.has(item.id));
  const representedSources = new Set(topK.map((item) => item.source));
  const missingSources = goldenCase.requiredSources
    .filter((source) => !representedSources.has(source));
  const counts = new Map<string, number>();
  for (const item of topK) counts.set(item.id, (counts.get(item.id) ?? 0) + 1);
  const duplicateEvidenceIds = [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([id]) => id)
    .sort();

  const recallAtK = matchedUniqueIds.size / expectedIds.size;
  const precisionAtK = topK.length === 0 ? 0 : matchedEvidenceIds.length / topK.length;
  const reciprocalRank = firstRelevantIndex === -1 ? 0 : 1 / (firstRelevantIndex + 1);
  const sourceCoverage =
    (goldenCase.requiredSources.length - missingSources.length) /
    goldenCase.requiredSources.length;
  const passed =
    duplicateEvidenceIds.length === 0 &&
    recallAtK >= goldenCase.thresholds.minimumRecallAtK &&
    precisionAtK >= goldenCase.thresholds.minimumPrecisionAtK &&
    reciprocalRank >= goldenCase.thresholds.minimumReciprocalRank &&
    sourceCoverage >= goldenCase.thresholds.minimumSourceCoverage;

  return KnowledgeRetrievalEvalReportSchema.parse({
    caseId: goldenCase.id,
    passed,
    k: goldenCase.thresholds.k,
    recallAtK,
    precisionAtK,
    reciprocalRank,
    sourceCoverage,
    matchedEvidenceIds,
    missingEvidenceIds,
    unexpectedEvidenceIds,
    missingSources,
    duplicateEvidenceIds,
  });
}
