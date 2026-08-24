import { z } from 'zod';

export const WorkflowStageSchema = z.enum([
  'refinement',
  'planning',
  'implementation',
  'verification',
  'triage',
  'release',
  'production',
]);

export const EvidenceSourceSchema = z.enum([
  'jira',
  'confluence',
  'github',
  'openapi',
  'test',
  'ci',
  'telemetry',
]);

export const ContextEvidenceSchema = z.object({
  id: z.string().min(1),
  source: EvidenceSourceSchema,
  uri: z.string().min(1),
  revision: z.string().min(1),
  retrievedAt: z.string().datetime(),
  content: z.string().min(1),
  estimatedTokens: z.number().int().positive(),
  relevance: z.number().min(0).max(1),
});

export const ContextPackSchema = z
  .object({
    schemaVersion: z.literal('1.0'),
    traceId: z.string().uuid(),
    objective: z.string().min(1),
    stage: WorkflowStageSchema,
    sourceRevisions: z.record(z.string(), z.string().min(1)),
    acceptanceCriteria: z.array(z.string().min(1)),
    constraints: z.array(z.string().min(1)),
    architectureFacts: z.array(z.string().min(1)),
    ownershipFacts: z.array(z.string().min(1)),
    priorSignals: z.array(z.string().min(1)),
    evidence: z.array(ContextEvidenceSchema),
    contradictions: z.array(z.string().min(1)),
    missingEvidence: z.array(z.string().min(1)),
    budget: z.object({
      maxTokens: z.number().int().positive(),
      reservedTokens: z.number().int().nonnegative(),
      evidenceTokenLimit: z.number().int().nonnegative(),
      usedEvidenceTokens: z.number().int().nonnegative(),
    }),
    omittedEvidenceIds: z.array(z.string().min(1)),
    truncated: z.boolean(),
  })
  .superRefine((pack, context) => {
    if (pack.budget.reservedTokens > pack.budget.maxTokens) {
      context.addIssue({
        code: 'custom',
        path: ['budget', 'reservedTokens'],
        message: 'Reserved tokens cannot exceed the total context budget.',
      });
    }

    const expectedLimit = pack.budget.maxTokens - pack.budget.reservedTokens;
    if (pack.budget.evidenceTokenLimit !== expectedLimit) {
      context.addIssue({
        code: 'custom',
        path: ['budget', 'evidenceTokenLimit'],
        message: 'Evidence token limit must equal maxTokens minus reservedTokens.',
      });
    }

    const usedTokens = pack.evidence.reduce((sum, item) => sum + item.estimatedTokens, 0);
    if (pack.budget.usedEvidenceTokens !== usedTokens) {
      context.addIssue({
        code: 'custom',
        path: ['budget', 'usedEvidenceTokens'],
        message: 'Used evidence tokens must equal the sum of selected evidence estimates.',
      });
    }

    if (usedTokens > pack.budget.evidenceTokenLimit) {
      context.addIssue({
        code: 'custom',
        path: ['evidence'],
        message: 'Selected evidence exceeds the evidence token limit.',
      });
    }

    if (pack.truncated !== (pack.omittedEvidenceIds.length > 0)) {
      context.addIssue({
        code: 'custom',
        path: ['truncated'],
        message: 'Truncated must indicate whether evidence was omitted.',
      });
    }
  });

export type ContextEvidence = z.infer<typeof ContextEvidenceSchema>;
export type ContextPack = z.infer<typeof ContextPackSchema>;
export type WorkflowStage = z.infer<typeof WorkflowStageSchema>;

export type ContextPackInput = Omit<
  ContextPack,
  'schemaVersion' | 'evidence' | 'budget' | 'omittedEvidenceIds' | 'truncated'
> & {
  candidates: ContextEvidence[];
  maxTokens: number;
  reservedTokens?: number;
};

function compareEvidence(left: ContextEvidence, right: ContextEvidence): number {
  return (
    right.relevance - left.relevance ||
    right.retrievedAt.localeCompare(left.retrievedAt) ||
    left.id.localeCompare(right.id)
  );
}

/**
 * Builds a deterministic evidence pack. Token counts are estimates supplied by
 * the source adapter; model-provider usage remains the authoritative cost record.
 */
export function buildContextPack(input: ContextPackInput): ContextPack {
  const maxTokens = z.number().int().positive().parse(input.maxTokens);
  const reservedTokens = z.number().int().nonnegative().parse(input.reservedTokens ?? 0);

  if (reservedTokens > maxTokens) {
    throw new Error('Reserved tokens cannot exceed the total context budget.');
  }

  const candidates = z.array(ContextEvidenceSchema).parse(input.candidates);
  const evidenceTokenLimit = maxTokens - reservedTokens;
  const selected: ContextEvidence[] = [];
  const omittedEvidenceIds: string[] = [];
  const seenSources = new Set<string>();
  let usedEvidenceTokens = 0;

  for (const candidate of [...candidates].sort(compareEvidence)) {
    const sourceRevision = `${candidate.uri}\u0000${candidate.revision}`;
    const fits = usedEvidenceTokens + candidate.estimatedTokens <= evidenceTokenLimit;

    if (seenSources.has(sourceRevision) || !fits) {
      omittedEvidenceIds.push(candidate.id);
      continue;
    }

    seenSources.add(sourceRevision);
    selected.push(candidate);
    usedEvidenceTokens += candidate.estimatedTokens;
  }

  return ContextPackSchema.parse({
    schemaVersion: '1.0',
    traceId: input.traceId,
    objective: input.objective,
    stage: input.stage,
    sourceRevisions: input.sourceRevisions,
    acceptanceCriteria: input.acceptanceCriteria,
    constraints: input.constraints,
    architectureFacts: input.architectureFacts,
    ownershipFacts: input.ownershipFacts,
    priorSignals: input.priorSignals,
    evidence: selected,
    contradictions: input.contradictions,
    missingEvidence: input.missingEvidence,
    budget: {
      maxTokens,
      reservedTokens,
      evidenceTokenLimit,
      usedEvidenceTokens,
    },
    omittedEvidenceIds,
    truncated: omittedEvidenceIds.length > 0,
  });
}
