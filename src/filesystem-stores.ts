import { randomUUID } from 'node:crypto';
import { link, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
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

const lockRetryMs = 10;
const lockTimeoutMs = 5_000;
const staleLockMs = 30_000;

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
  const json = `${JSON.stringify(value, null, 2)}\n`;
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${randomUUID()}.tmp`;

  try {
    const handle = await open(temporaryPath, 'wx');
    try {
      await handle.writeFile(json, 'utf8');
    } finally {
      await handle.close();
    }
    try {
      await link(temporaryPath, path);
    } catch (error) {
      if (isCode(error, 'EEXIST')) throw duplicate;
      throw error;
    }
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

async function ownerIsAlive(lockPath: string): Promise<boolean> {
  try {
    const owner = JSON.parse(await readFile(join(lockPath, 'owner.json'), 'utf8')) as {
      host?: unknown;
      pid?: unknown;
    };
    if (owner.host !== hostname() || typeof owner.pid !== 'number') return false;
    try {
      process.kill(owner.pid, 0);
      return true;
    } catch (error) {
      return !isCode(error, 'ESRCH');
    }
  } catch (error) {
    if (isCode(error, 'ENOENT') || error instanceof SyntaxError) return false;
    throw error;
  }
}

async function reclaimStaleLock(lockPath: string): Promise<void> {
  let lockStat;
  try {
    lockStat = await stat(lockPath);
  } catch (error) {
    if (isCode(error, 'ENOENT')) return;
    throw error;
  }
  if (Date.now() - lockStat.mtimeMs <= staleLockMs || (await ownerIsAlive(lockPath))) return;

  const stalePath = `${lockPath}.${randomUUID()}.stale`;
  try {
    await rename(lockPath, stalePath);
  } catch (error) {
    if (isCode(error, 'ENOENT')) return;
    throw error;
  }
  await rm(stalePath, { recursive: true, force: true });
}

async function acquireLock(path: string): Promise<string> {
  const lockPath = `${path}.lock`;
  const deadline = Date.now() + lockTimeoutMs;
  await mkdir(dirname(path), { recursive: true });
  while (true) {
    try {
      await mkdir(lockPath);
    } catch (error) {
      if (!isCode(error, 'EEXIST')) throw error;
      await reclaimStaleLock(lockPath);
      if (Date.now() >= deadline) throw new Error(`Timed out acquiring lock for '${path}'.`);
      await new Promise((resolve) => setTimeout(resolve, lockRetryMs));
      continue;
    }
    try {
      await writeFile(
        join(lockPath, 'owner.json'),
        `${JSON.stringify({ host: hostname(), pid: process.pid, createdAt: new Date().toISOString() })}\n`,
        'utf8',
      );
      return lockPath;
    } catch (error) {
      await rm(lockPath, { recursive: true, force: true });
      throw error;
    }
  }
}

async function withLock<T>(path: string, operation: () => Promise<T>): Promise<T> {
  const lockPath = await acquireLock(path);
  try {
    return await operation();
  } finally {
    await rm(lockPath, { recursive: true, force: true });
  }
}

export class FileArtifactStore implements ArtifactStore {
  constructor(private readonly root: string) {}

  pathFor(id: string): string {
    return join(this.root, 'artifacts', `${Buffer.from(id, 'utf8').toString('hex')}.json`);
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
    if (value === undefined) return undefined;
    const record = ArtifactRecordSchema.parse(value);
    if (record.id !== id) throw new Error(`Artifact '${id}' contains record '${record.id}'.`);
    return record;
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
    return join(this.root, 'workflows', `${Buffer.from(id, 'utf8').toString('hex')}.json`);
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
    if (value === undefined) return undefined;
    const record = WorkflowStateSchema.parse(value);
    if (record.id !== id) throw new Error(`Workflow '${id}' contains record '${record.id}'.`);
    return record;
  }

  save(state: WorkflowState, expectedVersion: number): Promise<WorkflowState> {
    const validated = WorkflowStateSchema.parse(state);
    const path = this.pathFor(validated.id);
    return withLock(path, async () => {
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
