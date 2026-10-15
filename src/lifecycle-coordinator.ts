import { z } from 'zod';
import {
  ConcurrencyConflictError,
  DuplicateRecordError,
  InvalidTransitionError,
  RecordIdSchema,
  RetryExhaustedError,
  WorkflowCancelledError,
  WorkflowStateSchema,
  type ArtifactRecord,
  type ArtifactStore,
  type WorkflowState,
  type WorkflowStore,
} from './contracts.js';
import { WorkflowStageSchema, type WorkflowStage } from './context.js';
import { validateReadinessPackage } from './readiness-validator.js';

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

type ArtifactContent = Record<string, unknown>;

function contentOf(record: ArtifactRecord): ArtifactContent {
  return record.content !== null && typeof record.content === 'object' && !Array.isArray(record.content)
    ? record.content as ArtifactContent
    : {};
}

function textField(record: ArtifactRecord, ...names: string[]): string | undefined {
  const content = contentOf(record);
  for (const name of names) {
    const value = content[name] ?? record.metadata[name];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

function hasType(record: ArtifactRecord, expected: string): boolean {
  return [record.kind, ...Object.keys(record.metadata).map((key) => record.metadata[key]),
    ...Object.keys(contentOf(record)).filter((key) => /type|kind|phase/i.test(key)).map((key) => contentOf(record)[key])]
    .some((value) => typeof value === 'string' && value.toLowerCase().replace(/[_ ]/g, '-') === expected);
}

function idsFrom(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function fieldIds(record: ArtifactRecord, ...names: string[]): string[] {
  const content = contentOf(record);
  for (const name of names) {
    const value = content[name];
    if (Array.isArray(value)) return idsFrom(value);
  }
  return [];
}

function ref(record: ArtifactRecord, ...names: string[]): string | undefined {
  return textField(record, ...names);
}

function phaseGateStatus(record: ArtifactRecord, phase: 'A' | 'B'): boolean {
  const content = contentOf(record);
  const expectedType = phase === 'A' ? 'phase-gate-acceptance' : 'phase-gate-approval';
  return hasType(record, expectedType)
    ? String(content.phase ?? record.metadata.phase ?? '').toUpperCase() === phase &&
      String(content.status ?? record.metadata.status ?? '').toLowerCase() === (phase === 'A' ? 'accepted' : 'approved')
    : false;
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

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    (typeof value === 'object' || typeof value === 'function') &&
    typeof (value as { then?: unknown }).then === 'function'
  );
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
  private readonly now: () => string;
  private readonly artifacts: ArtifactStore | undefined;

  constructor(
    private readonly workflows: WorkflowStore,
    nowOrArtifacts: (() => string) | ArtifactStore = () => new Date().toISOString(),
    artifacts?: ArtifactStore,
  ) {
    if (typeof nowOrArtifacts === 'function') {
      this.now = nowOrArtifacts;
      this.artifacts = artifacts;
    } else {
      this.now = () => new Date().toISOString();
      this.artifacts = nowOrArtifacts;
    }
  }

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
    await this.assertStageGate(state, target, artifactIds);
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
    await this.assertStageGate(initial, target);

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
          const result: unknown = retryable(error);
          if (isThenable(result)) {
            try {
              await result;
            } catch (predicateRejection) {
              throw new AggregateError([predicateRejection], 'Retry predicate rejected.', {
                cause: error,
              });
            }
          }
          shouldRetry = z.boolean().parse(result);
        } catch (predicateError) {
          await this.settle(running, 'failed');
          if (predicateError instanceof AggregateError && predicateError.cause === error) {
            throw predicateError;
          }
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
    if (state.status === 'waiting-for-human') {
      throw new Error(`Workflow '${state.id}' cannot advance while waiting-for-human.`);
    }
    if (terminalStatuses.has(state.status)) {
      throw new Error(
        `Workflow '${state.id}' cannot transition while status is '${state.status}'.`,
      );
    }
    if (nextStage[state.stage] !== to) throw new InvalidTransitionError(state.stage, to);
  }

  private async assertStageGate(
    state: WorkflowState,
    to: WorkflowStage,
    additionalArtifactIds: readonly string[] = [],
  ): Promise<void> {
    if (this.artifacts === undefined || (to !== 'planning' && to !== 'implementation')) return;

    const artifactIds = [...new Set([...state.artifactIds, ...additionalArtifactIds])];
    const records: ArtifactRecord[] = [];
    for (const id of artifactIds) {
      const record = await this.artifacts.get(RecordIdSchema.parse(id));
      if (record === undefined) throw new Error(`Workflow '${state.id}' references missing gate artifact '${id}'.`);
      if (record.traceId !== state.traceId) {
        throw new Error(`Gate artifact '${id}' belongs to another trace.`);
      }
      records.push(record);
    }

    const packageCandidates = records.flatMap((record) => {
      try {
        const packageValue = validateReadinessPackage(record.content);
        const decision = packageValue.proposedReadinessDecision ?? packageValue.readinessDecision;
        return packageValue.traceId === state.traceId && (decision === 'ready' || decision === 'ready-for-design')
          ? [{ record, packageValue }] : [];
      } catch {
        return [];
      }
    });
    if (packageCandidates.length !== 1) throw new Error('Phase A gate requires one validated ready Readiness Package.');
    const { record: packageRecord, packageValue } = packageCandidates[0]!;

    const reports = records.filter((record) => hasType(record, 'discrepancy-report'));
    const matrices = records.filter((record) => hasType(record, 'traceability-matrix') || hasType(record, 'rtm'));
    const report = reports.find((candidate) => ref(candidate, 'readinessPackageId', 'packageId') === packageValue.packageId);
    const matrix = matrices.find((candidate) => ref(candidate, 'readinessPackageId', 'packageId') === packageValue.packageId);
    if ((report === undefined) !== (matrix === undefined)) {
      throw new Error('Phase A gate requires a current discrepancy report and RTM for the Readiness Package.');
    }
    const reportForValidation = report ?? { ...packageRecord, content: {
      rows: contentOf(packageRecord).discrepancyRows ?? contentOf(packageRecord).discrepancies,
    } };
    const matrixForValidation = matrix ?? { ...packageRecord, content: {
      rows: contentOf(packageRecord).rtm ?? contentOf(packageRecord).requirementsTraceabilityMatrix,
    } };
    this.assertPhaseAArtifacts(packageValue, reportForValidation, matrixForValidation);

    const phaseAAcceptances = records.filter((record) => phaseGateStatus(record, 'A'))
      .filter((record) => ref(record, 'workflowId') === state.id &&
        ref(record, 'traceId') === state.traceId &&
        ref(record, 'readinessPackageId') === packageRecord.id &&
        (packageValue.revision === undefined ||
          ref(record, 'readinessPackageRevision', 'packageRevision') === packageValue.revision) &&
        (report === undefined || ref(record, 'discrepancyReportId') === report.id) &&
        (matrix === undefined || ref(record, 'traceabilityMatrixId', 'rtmId') === matrix.id));
    if (phaseAAcceptances.length !== 1) throw new Error('Phase A gate requires explicit SDET acceptance of the current package, discrepancy report, and RTM.');
    if (to === 'planning') return;

    const phaseBAcceptances = records.filter((record) => phaseGateStatus(record, 'B'))
      .filter((record) => ref(record, 'workflowId') === state.id &&
        ref(record, 'traceId') === state.traceId &&
        ref(record, 'readinessPackageId') === packageRecord.id &&
        (packageValue.revision === undefined ||
          ref(record, 'readinessPackageRevision', 'packageRevision') === packageValue.revision) &&
        (report === undefined || ref(record, 'discrepancyReportId') === report.id) &&
        (matrix === undefined || ref(record, 'traceabilityMatrixId', 'rtmId') === matrix.id) &&
        ref(record, 'phaseAAcceptanceId') === phaseAAcceptances[0]!.id);
    if (phaseBAcceptances.length !== 1) throw new Error('Phase B gate requires explicit approval of the bounded test-design path.');
  }

  private assertPhaseAArtifacts(
    packageValue: ReturnType<typeof validateReadinessPackage>,
    report: ArtifactRecord,
    matrix: ArtifactRecord,
  ): void {
    const reportContent = contentOf(report);
    const rows = Array.isArray(reportContent.rows) ? reportContent.rows : [];
    const blockers = reportContent.unresolvedBlockers ?? reportContent.blockers ?? [];
    const declaredEvidence = new Set(packageValue.provenance.sources.flatMap((source) => source.evidenceIds));
    if (rows.length === 0 || (Array.isArray(blockers) && blockers.length > 0)) {
      throw new Error('Phase A gate requires a resolved discrepancy report.');
    }
    const classifications = new Set(['aligned', 'extra', 'missing', 'conflict', 'silent']);
    for (const row of rows) {
      if (row === null || typeof row !== 'object' || !classifications.has(String((row as ArtifactContent).classification)) ||
        fieldIds({ ...report, content: row } as ArtifactRecord, 'evidenceIds').length === 0 ||
        fieldIds({ ...report, content: row } as ArtifactRecord, 'evidenceIds').some((id) => !declaredEvidence.has(id))) {
        throw new Error('Phase A gate requires classified, evidence-linked discrepancy rows.');
      }
    }

    const matrixRows: unknown[] = Array.isArray(contentOf(matrix).rows) ? contentOf(matrix).rows as unknown[] : [];
    const criteria = new Set(packageValue.acceptanceCriteria.map((criterion) => criterion.id));
    const mapped = new Set<string>();
    for (const row of matrixRows) {
      if (row === null || typeof row !== 'object') throw new Error('Phase A gate requires an evidence-linked RTM.');
      const value = row as ArtifactContent;
      const acId = typeof value.acId === 'string' ? value.acId : '';
      const expected = typeof value.expectedBehavior === 'string' ? value.expectedBehavior : '';
      const observable = typeof value.observableOutcome === 'string' ? value.observableOutcome : '';
      if (!criteria.has(acId) || mapped.has(acId) || expected.trim() === '' || observable.trim() === '' || expected.trim() === observable ||
        idsFrom(value.evidenceIds).length === 0 || idsFrom(value.evidenceIds).some((id) => !declaredEvidence.has(id))) {
        throw new Error('Phase A gate requires one distinct expected/observable RTM row per acceptance criterion.');
      }
      mapped.add(acId);
    }
    if (mapped.size !== criteria.size) throw new Error('Phase A gate RTM does not cover every acceptance criterion.');
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
