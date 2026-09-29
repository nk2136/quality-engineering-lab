import { z } from 'zod';
import {
  ConcurrencyConflictError,
  DuplicateRecordError,
  InvalidTransitionError,
  RecordIdSchema,
  RetryExhaustedError,
  WorkflowCancelledError,
  WorkflowStateSchema,
  type WorkflowState,
  type WorkflowStore,
} from './contracts.js';
import { WorkflowStageSchema, type WorkflowStage } from './context.js';

export interface StartWorkflowInput {
  id: string;
  traceId: string;
  stage?: WorkflowStage;
  approvalRequired?: boolean;
}

export interface RunOptions {
  maxAttempts?: number;
  retryable?: (error: unknown) => boolean;
}

const StartWorkflowInputSchema = z.object({
  id: RecordIdSchema,
  traceId: z.string().uuid(),
  stage: WorkflowStageSchema.optional(),
  approvalRequired: z.boolean().optional(),
});

const RunOptionsSchema = z.object({
  maxAttempts: z.number().int().positive().optional(),
  retryable: z
    .custom<NonNullable<RunOptions['retryable']>>((value) => typeof value === 'function')
    .optional(),
});

const HandoffArtifactIdsSchema = z.array(RecordIdSchema);

const nextStage: Partial<Record<WorkflowStage, WorkflowStage>> = {
  refinement: 'planning',
  planning: 'implementation',
  implementation: 'verification',
  verification: 'triage',
  triage: 'release',
  release: 'production',
};

const terminalStatuses = new Set<WorkflowState['status']>([
  'completed',
  'failed',
  'cancelled',
  'blocked',
]);

export class LifecycleCoordinator {
  constructor(
    private readonly workflows: WorkflowStore,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async start(input: StartWorkflowInput): Promise<WorkflowState> {
    const validatedInput = StartWorkflowInputSchema.parse(input);
    const state = WorkflowStateSchema.parse({
      id: validatedInput.id,
      traceId: validatedInput.traceId,
      stage: validatedInput.stage ?? 'refinement',
      status: 'pending',
      version: 0,
      updatedAt: this.now(),
      artifactIds: [],
      approval: {
        status: validatedInput.approvalRequired === false ? 'not-required' : 'pending',
        reviewer: null,
        reviewedAt: null,
      },
    });
    const existing = await this.workflows.get(state.id);
    if (existing !== undefined) {
      if (existing.traceId === state.traceId) return existing;
      throw new DuplicateRecordError('Workflow', state.id);
    }
    try {
      await this.workflows.create(state);
      return state;
    } catch (error) {
      if (!(error instanceof DuplicateRecordError)) throw error;
      const concurrent = await this.workflows.get(state.id);
      if (concurrent?.traceId === state.traceId) return WorkflowStateSchema.parse(concurrent);
      throw error;
    }
  }

  async resume(id: string): Promise<WorkflowState> {
    const validatedId = WorkflowStateSchema.shape.id.parse(id);
    const state = await this.workflows.get(validatedId);
    if (state === undefined) throw new Error(`Workflow '${validatedId}' does not exist.`);
    return WorkflowStateSchema.parse(state);
  }

  async transition(
    id: string,
    to: WorkflowStage,
    artifactIds: readonly string[] = [],
  ): Promise<WorkflowState> {
    const state = await this.resume(id);
    const target = WorkflowStageSchema.parse(to);
    this.assertTransition(state, target);
    return this.workflows.save(
      WorkflowStateSchema.parse({
        ...state,
        stage: target,
        status: 'pending',
        updatedAt: this.now(),
        artifactIds: [...new Set([...state.artifactIds, ...artifactIds])],
      }),
      state.version,
    );
  }

  async run(
    id: string,
    to: WorkflowStage,
    handoff: () => Promise<readonly string[]>,
    options: RunOptions = {},
  ): Promise<WorkflowState> {
    const validatedOptions = RunOptionsSchema.parse(options);
    const maxAttempts = validatedOptions.maxAttempts ?? 1;
    const retryable = validatedOptions.retryable ?? (() => false);
    const initial = await this.resume(id);
    const target = WorkflowStageSchema.parse(to);
    if (initial.status === 'cancelled') throw new WorkflowCancelledError(initial.id);
    this.assertTransition(initial, target);

    const running = await this.workflows.save(
      WorkflowStateSchema.parse({ ...initial, status: 'running', updatedAt: this.now() }),
      initial.version,
    );

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      await this.assertUnchangedRunning(running);
      let handoffOutput: readonly string[];
      try {
        handoffOutput = await handoff();
      } catch (error) {
        await this.assertUnchangedRunning(running);
        let shouldRetry: boolean;
        try {
          shouldRetry = z.boolean().parse(retryable(error));
        } catch (predicateError) {
          await this.settle(running, 'failed');
          throw this.withCause(predicateError, error);
        }
        if (!shouldRetry) {
          await this.settle(running, 'failed');
          throw error;
        }
        if (attempt === maxAttempts) {
          await this.settle(running, 'blocked');
          throw new RetryExhaustedError(initial.id, attempt, { cause: error });
        }
        continue;
      }

      await this.assertUnchangedRunning(running);
      let artifactIds: readonly string[];
      try {
        artifactIds = HandoffArtifactIdsSchema.parse(handoffOutput);
      } catch (error) {
        await this.settle(running, 'failed');
        throw error;
      }
      return this.workflows.save(
        WorkflowStateSchema.parse({
          ...running,
          stage: target,
          status: 'pending',
          updatedAt: this.now(),
          artifactIds: [...new Set([...running.artifactIds, ...artifactIds])],
        }),
        running.version,
      );
    }

    throw new Error('Unreachable workflow retry state.');
  }

  async cancel(id: string): Promise<WorkflowState> {
    const state = await this.resume(id);
    if (state.status === 'cancelled') return state;
    return this.workflows.save(
      WorkflowStateSchema.parse({ ...state, status: 'cancelled', updatedAt: this.now() }),
      state.version,
    );
  }

  private assertTransition(state: WorkflowState, to: WorkflowStage): void {
    if (terminalStatuses.has(state.status)) {
      throw new Error(
        `Workflow '${state.id}' cannot transition while status is '${state.status}'.`,
      );
    }
    if (nextStage[state.stage] !== to) throw new InvalidTransitionError(state.stage, to);
  }

  private async assertUnchangedRunning(running: WorkflowState): Promise<void> {
    const current = await this.resume(running.id);
    if (current.status === 'cancelled') throw new WorkflowCancelledError(current.id);
    if (current.version !== running.version || current.status !== 'running') {
      throw new ConcurrencyConflictError(running.id, running.version, current.version);
    }
  }

  private async settle(
    running: WorkflowState,
    status: 'failed' | 'blocked',
  ): Promise<WorkflowState> {
    await this.assertUnchangedRunning(running);
    return this.workflows.save(
      WorkflowStateSchema.parse({ ...running, status, updatedAt: this.now() }),
      running.version,
    );
  }

  private withCause(error: unknown, cause: unknown): Error {
    const wrapped = new Error(error instanceof Error ? error.message : String(error), { cause });
    if (error instanceof Error) wrapped.name = error.name;
    return wrapped;
  }
}
