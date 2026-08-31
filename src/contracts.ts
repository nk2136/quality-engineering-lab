import { z } from 'zod';
import type { ContextEvidence, ContextPack, WorkflowStage } from './context.js';

export const ModelTaskSchema = z.enum([
  'extract',
  'classify',
  'reason',
  'generate-code',
  'review',
]);

export const ModelCapabilitySchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  tasks: z.array(ModelTaskSchema).min(1),
  supportsStructuredOutput: z.boolean(),
  supportsTools: z.boolean(),
  contextWindowTokens: z.number().int().positive(),
  dataRegion: z.string().min(1).nullable(),
});

export const ModelRequestSchema = z.object({
  traceId: z.string().uuid(),
  task: ModelTaskSchema,
  promptVersion: z.string().min(1),
  input: z.string().min(1),
  maxOutputTokens: z.number().int().positive(),
});

export const ModelResponseSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  output: z.unknown(),
  usage: z.object({
    inputTokens: z.number().int().nonnegative(),
    cachedInputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
  }),
  finishReason: z.enum(['completed', 'length', 'refusal', 'tool-call', 'error']),
});

export type ModelCapability = z.infer<typeof ModelCapabilitySchema>;
export type ModelRequest = z.infer<typeof ModelRequestSchema>;
export type ModelResponse = z.infer<typeof ModelResponseSchema>;

export interface ModelGateway {
  capabilities(): Promise<readonly ModelCapability[]>;
  generate(request: ModelRequest, context: ContextPack): Promise<ModelResponse>;
}

export const KnowledgeQuerySchema = z.object({
  traceId: z.string().uuid(),
  text: z.string().min(1),
  sources: z.array(z.enum(['jira', 'confluence', 'github', 'openapi', 'test', 'ci', 'telemetry'])).min(1),
  maxResults: z.number().int().positive(),
  asOf: z.string().datetime(),
});

export type KnowledgeQuery = z.infer<typeof KnowledgeQuerySchema>;

export interface KnowledgeSource {
  search(query: KnowledgeQuery): Promise<readonly ContextEvidence[]>;
}

export const ArtifactKindSchema = z.enum([
  'context-pack',
  'story-readiness',
  'requirement-analysis',
  'test-design',
  'review',
  'approval',
  'failure-triage',
]);

export const ArtifactRecordSchema = z.object({
  id: z.string().min(1),
  traceId: z.string().uuid(),
  kind: ArtifactKindSchema,
  schemaVersion: z.string().min(1),
  createdAt: z.string().datetime(),
  content: z.unknown(),
  metadata: z.record(z.string(), z.string()),
});

export type ArtifactRecord = z.infer<typeof ArtifactRecordSchema>;

export interface ArtifactStore {
  put(artifact: ArtifactRecord): Promise<void>;
  get(id: string): Promise<ArtifactRecord | undefined>;
  listByTrace(traceId: string): Promise<readonly ArtifactRecord[]>;
}

export const WorkflowStateSchema = z.object({
  id: z.string().min(1),
  traceId: z.string().uuid(),
  stage: z.enum([
    'refinement',
    'planning',
    'implementation',
    'verification',
    'triage',
    'release',
    'production',
  ]),
  status: z.enum(['pending', 'running', 'waiting-for-human', 'completed', 'failed', 'cancelled']),
  version: z.number().int().nonnegative(),
  updatedAt: z.string().datetime(),
  artifactIds: z.array(z.string().min(1)),
  approval: z.object({
    status: z.enum(['not-required', 'pending', 'approved', 'rejected']),
    reviewer: z.string().min(1).nullable(),
    reviewedAt: z.string().datetime().nullable(),
  }),
});

export type WorkflowState = z.infer<typeof WorkflowStateSchema>;

export interface WorkflowStore {
  create(state: WorkflowState): Promise<void>;
  get(id: string): Promise<WorkflowState | undefined>;
  save(state: WorkflowState, expectedVersion: number): Promise<WorkflowState>;
}

export interface WorkflowTransition {
  from: WorkflowStage;
  to: WorkflowStage;
  requiresHumanApproval: boolean;
}

export class DuplicateRecordError extends Error {
  constructor(recordType: string, id: string) {
    super(`${recordType} '${id}' already exists.`);
    this.name = 'DuplicateRecordError';
  }
}

export class ConcurrencyConflictError extends Error {
  constructor(id: string, expectedVersion: number, actualVersion: number) {
    super(
      `Workflow '${id}' version conflict: expected ${expectedVersion}, found ${actualVersion}.`,
    );
    this.name = 'ConcurrencyConflictError';
  }
}
