import { z } from 'zod';
import {
  DuplicateRecordError,
  InvalidTransitionError,
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
    const state = WorkflowStateSchema.parse({
      id: input.id,
      traceId: input.traceId,
      stage: input.stage ?? 'refinement',
      status: 'pending',
      version: 0,
      updatedAt: this.now(),
      artifactIds: [],
      approval: {
        status: input.approvalRequired === false ? 'not-required' : 'pending',
        reviewer: null,
        reviewedAt: null,
      },
    });
    const existing = await this.workflows.get(state.id);
    if (existing !== undefined) {
      if (existing.traceId === state.traceId) return existing;
      throw new DuplicateRecordError('Workflow', state.id);
    }
    await this.workflows.create(state);
    return state;
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
    const maxAttempts = z.number().int().positive().parse(options.maxAttempts ?? 1);
    const retryable = options.retryable ?? (() => false);
    const initial = await this.resume(id);
    const target = WorkflowStageSchema.parse(to);
    if (initial.status === 'cancelled') throw new WorkflowCancelledError(initial.id);
    this.assertTransition(initial, target);

    await this.workflows.save(
      WorkflowStateSchema.parse({ ...initial, status: 'running', updatedAt: this.now() }),
      initial.version,
    );

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      let artifactIds: readonly string[];
      try {
        artifactIds = await handoff();
      } catch (error) {
        const current = await this.resume(initial.id);
        if (current.status === 'cancelled') throw new WorkflowCancelledError(current.id);
        if (!retryable(error)) {
          await this.workflows.save(
            WorkflowStateSchema.parse({ ...current, status: 'failed', updatedAt: this.now() }),
            current.version,
          );
          throw error;
        }
        if (attempt === maxAttempts) {
          await this.workflows.save(
            WorkflowStateSchema.parse({ ...current, status: 'blocked', updatedAt: this.now() }),
            current.version,
          );
          throw new RetryExhaustedError(initial.id, attempt, { cause: error });
        }
        continue;
      }

      const current = await this.resume(initial.id);
      if (current.status === 'cancelled') throw new WorkflowCancelledError(current.id);
      return this.workflows.save(
        WorkflowStateSchema.parse({
          ...current,
          stage: target,
          status: 'pending',
          updatedAt: this.now(),
          artifactIds: [...new Set([...current.artifactIds, ...artifactIds])],
        }),
        current.version,
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
}
