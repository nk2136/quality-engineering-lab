import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { WorkflowStageSchema } from './context.js';
import {
  ConcurrencyConflictError, RecordIdSchema, WorkflowStateSchema,
  type ArtifactStore, type WorkflowState, type WorkflowStore,
} from './contracts.js';

const TextSchema = z.string().trim().min(1).max(10_000);
const EvidenceIdsSchema = z.array(RecordIdSchema).min(1).max(50);
const QuestionSchema = z.strictObject({
  id: RecordIdSchema, acIds: z.array(TextSchema).min(1).max(50), owner: TextSchema,
  question: TextSchema, evidenceIds: EvidenceIdsSchema,
});
export const PauseForHumanSchema = z.strictObject({
  workflowId: RecordIdSchema, expectedVersion: z.number().int().nonnegative(),
  reason: z.enum(['clarification', 'access-data', 'design-decision', 'patch-review']),
  questions: z.array(QuestionSchema).min(1).max(50),
});
const AnswerSchema = z.strictObject({
  questionId: RecordIdSchema, answer: TextSchema, confirmedBy: TextSchema,
  evidenceIds: EvidenceIdsSchema,
});
export const HumanResponseInputSchema = z.strictObject({
  workflowId: RecordIdSchema, requestId: RecordIdSchema,
  expectedVersion: z.number().int().nonnegative(), responder: TextSchema,
  answers: z.array(AnswerSchema).min(1).max(50),
});
export const ResumeHumanDecisionSchema = z.strictObject({
  workflowId: RecordIdSchema, responseId: RecordIdSchema,
  expectedVersion: z.number().int().nonnegative(),
});
export const HumanDecisionRequestSchema = PauseForHumanSchema.omit({ expectedVersion: true }).extend({
  id: RecordIdSchema, stage: WorkflowStageSchema, workflowVersion: z.number().int().nonnegative(),
  subjectArtifactIds: z.array(RecordIdSchema), createdAt: z.string().datetime(),
});
export const HumanDecisionResponseSchema = HumanResponseInputSchema.omit({ expectedVersion: true }).extend({
  id: RecordIdSchema, stage: WorkflowStageSchema, workflowVersion: z.number().int().nonnegative(),
  recordedAt: z.string().datetime(),
});
type Request = z.infer<typeof HumanDecisionRequestSchema>;
type Response = z.infer<typeof HumanDecisionResponseSchema>;

/** Local identities are recorded claims. Responses never grant execution approval. */
export class HumanDecisionService {
  constructor(
    private readonly workflows: WorkflowStore,
    private readonly artifacts: ArtifactStore,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async pause(value: unknown): Promise<Request> {
    const input = PauseForHumanSchema.parse(value);
    const state = await this.current(input.workflowId, input.expectedVersion);
    if (state.status !== 'pending') throw new Error('Only a pending workflow can pause for human questions.');
    if (new Set(input.questions.map(q => q.id)).size !== input.questions.length) {
      throw new Error('Human questions must have unique IDs.');
    }
    await this.validateEvidence(state, input.questions.flatMap(q => q.evidenceIds));
    const { expectedVersion: _version, ...requestInput } = input;
    const request = HumanDecisionRequestSchema.parse({
      ...requestInput, id: `decision-${randomUUID()}`, stage: state.stage,
      workflowVersion: state.version + 1, subjectArtifactIds: [...state.artifactIds], createdAt: this.now(),
    });
    await this.artifacts.put({
      id: request.id, traceId: state.traceId, kind: 'human-decision-request', schemaVersion: '1.0',
      createdAt: request.createdAt, content: request, metadata: { workflowId: state.id },
    });
    // Only artifacts referenced by the successful checkpoint are accepted after a CAS conflict.
    await this.workflows.save({ ...state, status: 'waiting-for-human', updatedAt: request.createdAt,
      artifactIds: [...state.artifactIds, request.id] }, state.version);
    return request;
  }

  async listPending(workflowId: string): Promise<readonly Request[]> {
    const state = await this.current(workflowId);
    const records = await Promise.all(state.artifactIds.map(id => this.artifacts.get(id)));
    const responses = records.filter(r => r?.kind === 'human-decision-response')
      .map(r => HumanDecisionResponseSchema.parse(r!.content));
    return records.filter(r => r?.kind === 'human-decision-request')
      .map(r => HumanDecisionRequestSchema.parse(r!.content))
      .filter(r => r.workflowId === state.id && !responses.some(answer => answer.requestId === r.id));
  }

  async inspect(workflowId: string, requestId: string): Promise<{ request: Request; response?: Response }> {
    const state = await this.current(workflowId);
    const record = await this.boundArtifact(state, requestId, 'human-decision-request');
    const request = HumanDecisionRequestSchema.parse(record.content);
    if (request.workflowId !== state.id || request.id !== record.id) throw new Error('Decision belongs to another workflow.');
    const records = await Promise.all(state.artifactIds.map(id => this.artifacts.get(id)));
    const response = records.filter(r => r?.kind === 'human-decision-response')
      .map(r => HumanDecisionResponseSchema.parse(r!.content)).find(r => r.requestId === request.id);
    return response === undefined ? { request } : { request, response };
  }

  async respond(value: unknown): Promise<Response> {
    const input = HumanResponseInputSchema.parse(value);
    const state = await this.current(input.workflowId, input.expectedVersion);
    if (state.status !== 'waiting-for-human') throw new Error('Workflow must be waiting-for-human to accept a response.');
    const { request, response: existing } = await this.inspect(state.id, input.requestId);
    if (existing !== undefined) throw new Error('Decision already has an accepted response.');
    if (request.workflowVersion !== state.version || request.stage !== state.stage ||
      request.subjectArtifactIds.some(id => !state.artifactIds.includes(id))) {
      throw new Error('Decision is stale; investigate the changed workflow before answering.');
    }
    const questionIds = new Set(request.questions.map(q => q.id));
    if (input.answers.length !== questionIds.size || new Set(input.answers.map(a => a.questionId)).size !== questionIds.size ||
      input.answers.some(a => !questionIds.has(a.questionId))) {
      throw new Error('The response must answer every question exactly once.');
    }
    await this.validateEvidence(state, input.answers.flatMap(a => a.evidenceIds));
    const { expectedVersion: _version, ...responseInput } = input;
    const response = HumanDecisionResponseSchema.parse({ ...responseInput, id: `answer-${randomUUID()}`,
      stage: state.stage, workflowVersion: state.version, recordedAt: this.now() });
    await this.artifacts.put({ id: response.id, traceId: state.traceId, kind: 'human-decision-response',
      schemaVersion: '1.0', createdAt: response.recordedAt, content: response, metadata: { workflowId: state.id } });
    await this.workflows.save({ ...state, updatedAt: response.recordedAt,
      artifactIds: [...state.artifactIds, response.id] }, state.version);
    return response;
  }

  async resume(value: unknown): Promise<WorkflowState> {
    const input = ResumeHumanDecisionSchema.parse(value);
    const state = await this.current(input.workflowId, input.expectedVersion);
    if (state.status !== 'waiting-for-human') throw new Error('Workflow must be waiting-for-human to resume a decision.');
    const record = await this.boundArtifact(state, input.responseId, 'human-decision-response');
    const response = HumanDecisionResponseSchema.parse(record.content);
    const { request, response: accepted } = await this.inspect(state.id, response.requestId);
    if (response.workflowId !== state.id || response.id !== accepted?.id || response.stage !== state.stage ||
      state.version !== response.workflowVersion + 1 || request.workflowVersion !== response.workflowVersion) {
      throw new Error('Decision response is stale; revalidation is required before resuming.');
    }
    await this.validateEvidence(state, response.answers.flatMap(a => a.evidenceIds));
    return this.workflows.save({ ...state, status: 'pending', updatedAt: this.now() }, state.version);
  }

  private async current(id: string, version?: number): Promise<WorkflowState> {
    const state = await this.workflows.get(RecordIdSchema.parse(id));
    if (state === undefined) throw new Error(`Workflow '${id}' does not exist.`);
    const parsed = WorkflowStateSchema.parse(state);
    if (version !== undefined && parsed.version !== version) throw new ConcurrencyConflictError(id, version, parsed.version);
    return parsed;
  }

  private async boundArtifact(state: WorkflowState, id: string, kind?: string) {
    const record = await this.artifacts.get(RecordIdSchema.parse(id));
    if (!state.artifactIds.includes(id) || record === undefined || record.traceId !== state.traceId ||
      (kind !== undefined && record.kind !== kind)) throw new Error(`Artifact '${id}' is not valid workflow evidence.`);
    return record;
  }

  private async validateEvidence(state: WorkflowState, ids: readonly string[]): Promise<void> {
    for (const id of ids) {
      const record = await this.boundArtifact(state, id);
      if (record.kind === 'human-decision-request' || record.kind === 'human-decision-response') {
        throw new Error('Decision artifacts cannot substantiate their own answers.');
      }
    }
  }
}
