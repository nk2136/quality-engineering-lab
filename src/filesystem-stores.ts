import { mkdir, open, readdir, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
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
import { readJson, writeJsonAtomic } from './io.js';

const saveQueues = new Map<string, Promise<unknown>>();

function isCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

async function readOptional(path: string): Promise<unknown | undefined> {
  try {
    return await readJson(path);
  } catch (error) {
    if (isCode(error, 'ENOENT')) return undefined;
    throw error;
  }
}

async function createExclusive(path: string, value: unknown, duplicate: Error): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  let handle;
  try {
    handle = await open(path, 'wx');
  } catch (error) {
    if (isCode(error, 'EEXIST')) throw duplicate;
    throw error;
  }

  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(path, { force: true });
    throw error;
  }
  await handle.close();
}

function serialize<T>(path: string, operation: () => Promise<T>): Promise<T> {
  const key = process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path);
  const previous = saveQueues.get(key) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  saveQueues.set(key, current);
  void current.finally(() => {
    if (saveQueues.get(key) === current) saveQueues.delete(key);
  }).catch(() => undefined);
  return current;
}

export class FileArtifactStore implements ArtifactStore {
  constructor(private readonly root: string) {}

  pathFor(id: string): string {
    return join(this.root, 'artifacts', `${Buffer.from(id).toString('base64url')}.json`);
  }

  async put(artifact: ArtifactRecord): Promise<void> {
    const validated = ArtifactRecordSchema.parse(artifact);
    await createExclusive(
      this.pathFor(validated.id),
      validated,
      new DuplicateRecordError('Artifact', validated.id),
    );
  }

  async get(id: string): Promise<ArtifactRecord | undefined> {
    const value = await readOptional(this.pathFor(id));
    return value === undefined ? undefined : ArtifactRecordSchema.parse(value);
  }

  async listByTrace(traceId: string): Promise<readonly ArtifactRecord[]> {
    const directory = join(this.root, 'artifacts');
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (isCode(error, 'ENOENT')) return [];
      throw error;
    }

    const records = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
        .map((entry) => readJson(join(directory, entry.name))),
    );
    return records
      .map((record) => ArtifactRecordSchema.parse(record))
      .filter((record) => record.traceId === traceId)
      .sort(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
      );
  }
}

export class FileWorkflowStore implements WorkflowStore {
  constructor(private readonly root: string) {}

  pathFor(id: string): string {
    return join(this.root, 'workflows', `${Buffer.from(id).toString('base64url')}.json`);
  }

  async create(state: WorkflowState): Promise<void> {
    const validated = WorkflowStateSchema.parse(state);
    await createExclusive(
      this.pathFor(validated.id),
      validated,
      new DuplicateRecordError('Workflow', validated.id),
    );
  }

  async get(id: string): Promise<WorkflowState | undefined> {
    const value = await readOptional(this.pathFor(id));
    return value === undefined ? undefined : WorkflowStateSchema.parse(value);
  }

  save(state: WorkflowState, expectedVersion: number): Promise<WorkflowState> {
    const validated = WorkflowStateSchema.parse(state);
    const path = this.pathFor(validated.id);
    return serialize(path, async () => {
      const current = await this.get(validated.id);
      if (current === undefined) throw new Error(`Workflow '${validated.id}' does not exist.`);
      if (current.version !== expectedVersion) {
        throw new ConcurrencyConflictError(validated.id, expectedVersion, current.version);
      }
      if (validated.version !== expectedVersion) {
        throw new Error('The submitted workflow version must match expectedVersion.');
      }

      const saved = WorkflowStateSchema.parse({ ...validated, version: expectedVersion + 1 });
      await writeJsonAtomic(path, saved);
      return saved;
    });
  }
}
