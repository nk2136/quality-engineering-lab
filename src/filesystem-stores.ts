import { randomUUID } from 'node:crypto';
import { link, mkdir, open, readdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  ArtifactRecordSchema,
  ConcurrencyConflictError,
  DuplicateRecordError,
  RecordIdSchema,
  WorkflowStateSchema,
  type ArtifactRecord,
  type ArtifactStore,
  type WorkflowState,
  type WorkflowStore,
} from './contracts.js';
import { readJson } from './io.js';

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

async function publishExclusive(path: string, value: unknown): Promise<boolean> {
  const json = `${JSON.stringify(value, null, 2)}\n`;
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = join(dirname(path), `.${randomUUID()}.tmp`);

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
      if (isCode(error, 'EEXIST')) return false;
      throw error;
    }
    return true;
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

async function createExclusive(path: string, value: unknown, duplicate: Error): Promise<void> {
  if (!(await publishExclusive(path, value))) throw duplicate;
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

  pathFor(id: string, version = 0): string {
    return join(
      this.root,
      'workflows',
      Buffer.from(id, 'utf8').toString('hex'),
      `${version}.json`,
    );
  }

  async create(state: WorkflowState): Promise<void> {
    const validated = WorkflowStateSchema.parse(state);
    if (validated.version !== 0) throw new Error('A new workflow must start at version 0.');
    await createExclusive(
      this.pathFor(validated.id),
      validated,
      new DuplicateRecordError('Workflow', validated.id),
    );
  }

  async get(id: string): Promise<WorkflowState | undefined> {
    const validatedId = RecordIdSchema.parse(id);
    const directory = dirname(this.pathFor(validatedId));
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (isCode(error, 'ENOENT')) return undefined;
      throw error;
    }
    const versions = entries
      .filter((entry) => entry.isFile() && /^(0|[1-9]\d*)\.json$/.test(entry.name))
      .map((entry) => entry.name.slice(0, -5))
      .sort((left, right) => right.length - left.length || right.localeCompare(left));
    if (versions.length === 0) return undefined;
    const version = versions[0];
    const record = WorkflowStateSchema.parse(await readJson(join(directory, `${version}.json`)));
    if (record.id !== id) throw new Error(`Workflow '${id}' contains record '${record.id}'.`);
    if (String(record.version) !== version) {
      throw new Error(`Workflow '${id}' checkpoint ${version} contains version ${record.version}.`);
    }
    return record;
  }

  async save(state: WorkflowState, expectedVersion: number): Promise<WorkflowState> {
    const validated = WorkflowStateSchema.parse(state);
    const expected = WorkflowStateSchema.shape.version.parse(expectedVersion);
    const current = await this.get(validated.id);
    if (current === undefined) throw new Error(`Workflow '${validated.id}' does not exist.`);
    if (current.version !== expected) {
      throw new ConcurrencyConflictError(validated.id, expected, current.version);
    }
    if (validated.version !== expected) {
      throw new Error('The submitted workflow version must match expectedVersion.');
    }

    const saved = WorkflowStateSchema.parse({ ...validated, version: expected + 1 });
    if (await publishExclusive(this.pathFor(validated.id, saved.version), saved)) return saved;

    const actual = await this.get(validated.id);
    throw new ConcurrencyConflictError(validated.id, expected, actual?.version ?? saved.version);
  }
}
