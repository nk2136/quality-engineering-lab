import { randomUUID } from 'node:crypto';
import { link, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
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

interface LockTiming {
  retryMs: number;
  timeoutMs: number;
  staleMs: number;
  heartbeatMs: number;
}

interface LeaseOwner {
  token: string;
  createdAt: string;
  renewedAt: string;
}

interface Lease {
  lockPath: string;
  token: string;
  createdAt: string;
  dev: number;
  ino: number;
  lost?: Error;
}

export interface FileWorkflowStoreOptions {
  lockRetryMs?: number;
  lockTimeoutMs?: number;
  lockStaleMs?: number;
  lockHeartbeatMs?: number;
}

function lockTiming(options: FileWorkflowStoreOptions): LockTiming {
  const timing = {
    retryMs: options.lockRetryMs ?? 10,
    timeoutMs: options.lockTimeoutMs ?? 5_000,
    staleMs: options.lockStaleMs ?? 30_000,
    heartbeatMs: options.lockHeartbeatMs ?? 5_000,
  };
  if (Object.values(timing).some((value) => !Number.isFinite(value) || value <= 0)) {
    throw new Error('Workflow lock timing values must be positive.');
  }
  if (timing.heartbeatMs >= timing.staleMs) {
    throw new Error('Workflow lock heartbeat must be shorter than the stale threshold.');
  }
  return timing;
}

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

async function readLeaseOwner(lockPath: string): Promise<LeaseOwner | undefined> {
  try {
    const owner = JSON.parse(await readFile(join(lockPath, 'owner.json'), 'utf8')) as Partial<LeaseOwner>;
    if (
      typeof owner.token !== 'string' ||
      owner.token.length === 0 ||
      typeof owner.createdAt !== 'string' ||
      !Number.isFinite(Date.parse(owner.createdAt)) ||
      typeof owner.renewedAt !== 'string' ||
      !Number.isFinite(Date.parse(owner.renewedAt))
    ) return undefined;
    return owner as LeaseOwner;
  } catch (error) {
    if (isCode(error, 'ENOENT') || error instanceof SyntaxError) return undefined;
    throw error;
  }
}

async function leaseExpired(lockPath: string, owner: LeaseOwner | undefined, staleMs: number): Promise<boolean> {
  if (owner !== undefined) return Date.now() - Date.parse(owner.renewedAt) > staleMs;
  try {
    return Date.now() - (await stat(lockPath)).mtimeMs > staleMs;
  } catch (error) {
    if (isCode(error, 'ENOENT')) return false;
    throw error;
  }
}

function sameOwner(left: LeaseOwner | undefined, right: LeaseOwner | undefined): boolean {
  return left?.token === right?.token && left?.renewedAt === right?.renewedAt;
}

async function reclaimExpiredLease(lockPath: string, timing: LockTiming): Promise<void> {
  const first = await readLeaseOwner(lockPath);
  if (!(await leaseExpired(lockPath, first, timing.staleMs))) return;
  const second = await readLeaseOwner(lockPath);
  if (!sameOwner(first, second) || !(await leaseExpired(lockPath, second, timing.staleMs))) return;

  const stalePath = `${lockPath}.${randomUUID()}.stale`;
  try {
    await rename(lockPath, stalePath);
  } catch (error) {
    if (isCode(error, 'ENOENT')) return;
    throw error;
  }
  const movedOwner = await readLeaseOwner(stalePath);
  if (!sameOwner(second, movedOwner) && !(await leaseExpired(stalePath, movedOwner, timing.staleMs))) {
    try {
      await rename(stalePath, lockPath);
      return;
    } catch (error) {
      if (!isCode(error, 'EEXIST')) throw error;
      return;
    }
  }
  await rm(stalePath, { recursive: true, force: true });
}

async function writeLeaseOwner(lockPath: string, owner: LeaseOwner): Promise<void> {
  const ownerPath = join(lockPath, 'owner.json');
  const temporaryPath = join(lockPath, `${randomUUID()}.tmp`);
  try {
    await writeFile(temporaryPath, `${JSON.stringify(owner)}\n`, { encoding: 'utf8', flag: 'wx' });
    await rename(temporaryPath, ownerPath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

async function acquireLease(path: string, timing: LockTiming): Promise<Lease> {
  const lockPath = `${path}.lock`;
  const deadline = Date.now() + timing.timeoutMs;
  await mkdir(dirname(path), { recursive: true });
  while (true) {
    try {
      await mkdir(lockPath);
    } catch (error) {
      if (!isCode(error, 'EEXIST')) throw error;
      await reclaimExpiredLease(lockPath, timing);
      if (Date.now() >= deadline) throw new Error(`Timed out acquiring lease for '${path}'.`);
      await new Promise((resolve) => setTimeout(resolve, timing.retryMs));
      continue;
    }
    const token = randomUUID();
    const createdAt = new Date().toISOString();
    try {
      await writeLeaseOwner(lockPath, { token, createdAt, renewedAt: createdAt });
      const lockStat = await stat(lockPath);
      return { lockPath, token, createdAt, dev: lockStat.dev, ino: lockStat.ino };
    } catch (error) {
      await rm(lockPath, { recursive: true, force: true });
      throw error;
    }
  }
}

async function renewLease(lease: Lease): Promise<void> {
  if (lease.lost !== undefined) throw lease.lost;
  const lockStat = await stat(lease.lockPath).catch(() => undefined);
  const owner = await readLeaseOwner(lease.lockPath);
  if (
    lockStat === undefined ||
    lockStat.dev !== lease.dev ||
    lockStat.ino !== lease.ino ||
    owner?.token !== lease.token
  ) {
    lease.lost = new Error(`Workflow lease '${lease.token}' was lost.`);
    throw lease.lost;
  }
  try {
    await writeLeaseOwner(lease.lockPath, {
      token: lease.token,
      createdAt: lease.createdAt,
      renewedAt: new Date().toISOString(),
    });
    const renewedStat = await stat(lease.lockPath);
    const renewedOwner = await readLeaseOwner(lease.lockPath);
    if (
      renewedStat.dev !== lease.dev ||
      renewedStat.ino !== lease.ino ||
      renewedOwner?.token !== lease.token
    ) throw new Error(`Workflow lease '${lease.token}' was lost.`);
  } catch (error) {
    lease.lost = error instanceof Error ? error : new Error('Workflow lease was lost.');
    throw lease.lost;
  }
}

async function releaseLease(lease: Lease): Promise<void> {
  const lockStat = await stat(lease.lockPath).catch(() => undefined);
  const owner = await readLeaseOwner(lease.lockPath);
  if (
    lockStat === undefined ||
    lockStat.dev !== lease.dev ||
    lockStat.ino !== lease.ino ||
    owner?.token !== lease.token
  ) return;

  const releasePath = `${lease.lockPath}.${randomUUID()}.release`;
  try {
    await rename(lease.lockPath, releasePath);
  } catch (error) {
    if (isCode(error, 'ENOENT')) return;
    throw error;
  }
  const movedOwner = await readLeaseOwner(releasePath);
  if (movedOwner?.token !== lease.token) {
    try {
      await rename(releasePath, lease.lockPath);
    } catch (error) {
      if (!isCode(error, 'EEXIST')) throw error;
    }
    return;
  }
  await rm(releasePath, { recursive: true, force: true });
}

async function withLease<T>(
  path: string,
  timing: LockTiming,
  operation: (assertLease: () => Promise<void>) => Promise<T>,
): Promise<T> {
  const lease = await acquireLease(path, timing);
  let heartbeatRenewal: Promise<void> | undefined;
  const heartbeat = setInterval(() => {
    if (heartbeatRenewal !== undefined || lease.lost !== undefined) return;
    heartbeatRenewal = renewLease(lease)
      .catch(() => undefined)
      .finally(() => {
        heartbeatRenewal = undefined;
      });
  }, timing.heartbeatMs);
  heartbeat.unref();
  try {
    return await operation(() => renewLease(lease));
  } finally {
    clearInterval(heartbeat);
    await heartbeatRenewal;
    await releaseLease(lease);
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
  private readonly timing: LockTiming;

  constructor(private readonly root: string, options: FileWorkflowStoreOptions = {}) {
    this.timing = lockTiming(options);
  }

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
    return withLease(path, this.timing, async (assertLease) => {
      const current = await this.get(validated.id);
      if (current === undefined) throw new Error(`Workflow '${validated.id}' does not exist.`);
      if (current.version !== expectedVersion) {
        throw new ConcurrencyConflictError(validated.id, expectedVersion, current.version);
      }
      if (validated.version !== expectedVersion) {
        throw new Error('The submitted workflow version must match expectedVersion.');
      }

      const saved = WorkflowStateSchema.parse({ ...validated, version: expectedVersion + 1 });
      await assertLease();
      await writeJsonAtomic(path, saved);
      await assertLease();
      return saved;
    });
  }
}
