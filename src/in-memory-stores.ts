import {
  ArtifactRecordSchema,
  ConcurrencyConflictError,
  DuplicateRecordError,
  WorkflowStateSchema,
  type ArtifactRecord,
  type ArtifactStore,
  type WorkflowState,
  type WorkflowStore,
} from './contracts.js';

function copy<T>(value: T): T {
  return structuredClone(value);
}

export class InMemoryArtifactStore implements ArtifactStore {
  readonly #artifacts = new Map<string, ArtifactRecord>();

  async put(artifact: ArtifactRecord): Promise<void> {
    const validated = ArtifactRecordSchema.parse(artifact);
    if (this.#artifacts.has(validated.id)) {
      throw new DuplicateRecordError('Artifact', validated.id);
    }
    this.#artifacts.set(validated.id, copy(validated));
  }

  async get(id: string): Promise<ArtifactRecord | undefined> {
    const artifact = this.#artifacts.get(id);
    return artifact === undefined ? undefined : copy(artifact);
  }

  async listByTrace(traceId: string): Promise<readonly ArtifactRecord[]> {
    return [...this.#artifacts.values()]
      .filter((artifact) => artifact.traceId === traceId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
      .map(copy);
  }
}

export class InMemoryWorkflowStore implements WorkflowStore {
  readonly #workflows = new Map<string, WorkflowState>();

  async create(state: WorkflowState): Promise<void> {
    const validated = WorkflowStateSchema.parse(state);
    if (this.#workflows.has(validated.id)) {
      throw new DuplicateRecordError('Workflow', validated.id);
    }
    this.#workflows.set(validated.id, copy(validated));
  }

  async get(id: string): Promise<WorkflowState | undefined> {
    const state = this.#workflows.get(id);
    return state === undefined ? undefined : copy(state);
  }

  async save(state: WorkflowState, expectedVersion: number): Promise<WorkflowState> {
    const validated = WorkflowStateSchema.parse(state);
    const current = this.#workflows.get(validated.id);

    if (current === undefined) {
      throw new Error(`Workflow '${validated.id}' does not exist.`);
    }
    if (current.version !== expectedVersion) {
      throw new ConcurrencyConflictError(validated.id, expectedVersion, current.version);
    }
    if (validated.version !== expectedVersion) {
      throw new Error('The submitted workflow version must match expectedVersion.');
    }

    const saved = WorkflowStateSchema.parse({ ...validated, version: expectedVersion + 1 });
    this.#workflows.set(saved.id, copy(saved));
    return copy(saved);
  }
}
