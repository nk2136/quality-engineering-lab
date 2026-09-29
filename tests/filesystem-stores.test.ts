import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { access, mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ConcurrencyConflictError,
  DuplicateRecordError,
  type ArtifactRecord,
  type WorkflowState,
} from '../src/contracts.js';
import { FileArtifactStore, FileWorkflowStore } from '../src/filesystem-stores.js';

const roots: string[] = [];
const traceId = '3d594650-3436-4d7c-86a7-2b94788009bc';

function workflow(): WorkflowState {
  return {
    id: 'story/QE-42',
    traceId,
    stage: 'refinement',
    status: 'pending',
    version: 0,
    updatedAt: '2026-09-29T12:00:00.000Z',
    artifactIds: [],
    approval: { status: 'pending', reviewer: null, reviewedAt: null },
  };
}

function artifact(id = 'context/QE-42'): ArtifactRecord {
  return {
    id,
    traceId,
    kind: 'context-pack',
    schemaVersion: '1.0',
    createdAt: '2026-09-29T12:00:00.000Z',
    content: { objective: 'Assess QE-42.' },
    metadata: { source: 'test' },
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function root(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'qe-store-'));
  roots.push(path);
  return path;
}

async function waitFor(path: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      await access(path);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error(`Timed out waiting for ${path}`);
}

function saveInChild(path: string, name: string, status: string) {
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', 'tests/fixtures/save-workflow.ts', path, name, status],
    { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let output = '';
  let errors = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => (output += chunk));
  child.stderr.setEncoding('utf8').on('data', (chunk) => (errors += chunk));
  return {
    child,
    result: once(child, 'exit').then(([code]) => ({ code, output: output.trim(), errors })),
  };
}

describe('filesystem stores', () => {
  it('persists path-safe workflow and artifact identifiers across store instances', async () => {
    const path = await root();
    await new FileWorkflowStore(path).create(workflow());
    await new FileArtifactStore(path).put(artifact());

    expect(await new FileWorkflowStore(path).get('story/QE-42')).toEqual(workflow());
    expect(await new FileArtifactStore(path).get('context/QE-42')).toEqual(artifact());
  });

  it('rejects duplicate workflows and artifacts', async () => {
    const path = await root();
    const workflows = new FileWorkflowStore(path);
    const artifacts = new FileArtifactStore(path);
    await workflows.create(workflow());
    await artifacts.put(artifact());

    await expect(workflows.create(workflow())).rejects.toBeInstanceOf(DuplicateRecordError);
    await expect(artifacts.put(artifact())).rejects.toBeInstanceOf(DuplicateRecordError);
  });

  it('increments workflow versions once and rejects stale saves', async () => {
    const store = new FileWorkflowStore(await root());
    await store.create(workflow());

    const saved = await store.save({ ...workflow(), status: 'running' }, 0);

    expect(saved.version).toBe(1);
    await expect(store.save(saved, 0)).rejects.toBeInstanceOf(ConcurrencyConflictError);
  });

  it('validates persisted data when it is read', async () => {
    const store = new FileWorkflowStore(await root());
    await store.create(workflow());
    await writeFile(store.pathFor('story/QE-42'), '{"status":"invented"}\n', 'utf8');

    await expect(store.get('story/QE-42')).rejects.toThrow();
  });

  it('rejects a valid record stored under a different identifier', async () => {
    const path = await root();
    const artifacts = new FileArtifactStore(path);
    const workflows = new FileWorkflowStore(path);
    await artifacts.put(artifact('actual-artifact'));
    await workflows.create({ ...workflow(), id: 'actual-workflow' });
    await writeFile(artifacts.pathFor('requested-artifact'), JSON.stringify(artifact('actual-artifact')));
    await writeFile(
      workflows.pathFor('requested-workflow'),
      JSON.stringify({ ...workflow(), id: 'actual-workflow' }),
    );

    await expect(artifacts.get('requested-artifact')).rejects.toThrow(/requested-artifact/);
    await expect(workflows.get('requested-workflow')).rejects.toThrow(/requested-workflow/);
  });

  it('lists trace artifacts by createdAt then id', async () => {
    const store = new FileArtifactStore(await root());
    await store.put({ ...artifact('later'), createdAt: '2026-09-29T12:02:00.000Z' });
    await store.put({ ...artifact('z-tie'), createdAt: '2026-09-29T12:01:00.000Z' });
    await store.put({ ...artifact('a-tie'), createdAt: '2026-09-29T12:01:00.000Z' });
    await store.put({ ...artifact('other-trace'), traceId: '66d2283c-30f5-46eb-b76c-8e87cb658e22' });

    expect((await store.listByTrace(traceId)).map(({ id }) => id)).toEqual([
      'a-tie',
      'z-tie',
      'later',
    ]);
  });

  it('allows only one concurrent save for the same workflow version', async () => {
    const path = await root();
    const first = new FileWorkflowStore(path);
    const second = new FileWorkflowStore(path);
    await first.create(workflow());

    const results = await Promise.allSettled([
      first.save({ ...workflow(), status: 'running' }, 0),
      second.save({ ...workflow(), status: 'waiting-for-human' }, 0),
    ]);

    expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(({ status }) => status === 'rejected')).toHaveLength(1);
    expect(results.find(({ status }) => status === 'rejected')).toMatchObject({
      reason: expect.any(ConcurrencyConflictError),
    });
    expect(await first.get(workflow().id)).toMatchObject({ version: 1 });
  });

  it('allows only one cross-process save for the same workflow version', async () => {
    const path = await root();
    const store = new FileWorkflowStore(path);
    await store.create(workflow());
    const first = saveInChild(path, 'first', 'running');
    const second = saveInChild(path, 'second', 'waiting-for-human');
    await Promise.all([
      waitFor(join(path, 'ready-first')),
      waitFor(join(path, 'ready-second')),
    ]);

    await writeFile(join(path, 'go'), 'go', 'utf8');
    const results = await Promise.all([first.result, second.result]);

    expect(results.map(({ output }) => output).sort()).toEqual([
      'ConcurrencyConflictError',
      'success',
    ]);
    expect(results.map(({ code }) => code)).toEqual([0, 0]);
    expect(results.map(({ errors }) => errors)).toEqual(['', '']);
    expect(await store.get(workflow().id)).toMatchObject({ version: 1 });
  }, 20_000);

  it('reclaims stale crashed locks without deleting a live owner lock', async () => {
    const path = await root();
    const store = new FileWorkflowStore(path);
    await store.create(workflow());
    const lockPath = `${store.pathFor(workflow().id)}.lock`;
    const old = new Date(Date.now() - 60_000);
    await mkdir(lockPath);
    await writeFile(join(lockPath, 'owner.json'), '{interrupted', 'utf8');
    await utimes(lockPath, old, old);
    await expect(store.save({ ...workflow(), status: 'running' }, 0)).resolves.toMatchObject({
      version: 1,
    });

    await mkdir(lockPath);
    await writeFile(
      join(lockPath, 'owner.json'),
      JSON.stringify({ host: hostname(), pid: process.pid }),
      'utf8',
    );
    await utimes(lockPath, old, old);
    const pending = store.save(
      { ...(await store.get(workflow().id))!, status: 'waiting-for-human' },
      1,
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    await expect(access(lockPath)).resolves.toBeUndefined();
    await rm(lockPath, { recursive: true });
    await expect(pending).resolves.toMatchObject({ version: 2 });
  });

  it('does not expose partial JSON while publishing a new artifact', async () => {
    const path = await root();
    const writer = new FileArtifactStore(path);
    const reader = new FileArtifactStore(path);
    const value = { ...artifact('large'), content: { payload: 'x'.repeat(20_000_000) } };
    let settled = false;
    let readError: unknown;
    const pending = writer.put(value).finally(() => {
      settled = true;
    });

    while (!settled) {
      try {
        await reader.get(value.id);
      } catch (error) {
        readError = error;
        break;
      }
    }
    await pending;

    expect(readError).toBeUndefined();
    expect(await reader.get(value.id)).toEqual(value);
  }, 20_000);

  it('leaves no final record when publication preparation fails', async () => {
    const store = new FileArtifactStore(await root());
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    await expect(store.put({ ...artifact('retryable'), content: circular })).rejects.toThrow();
    await expect(store.get('retryable')).resolves.toBeUndefined();
    await expect(store.put(artifact('retryable'))).resolves.toBeUndefined();
    expect(await store.get('retryable')).toEqual(artifact('retryable'));
  });

  it('keeps UTF-8 identifiers distinct when base64url differs only by case', async () => {
    const store = new FileArtifactStore(await root());
    const upperAlias = '\u0800';
    const lowerAlias = '\u081A';

    expect(store.pathFor(upperAlias).toLowerCase()).not.toBe(store.pathFor(lowerAlias).toLowerCase());
    await store.put(artifact(upperAlias));
    await store.put(artifact(lowerAlias));

    expect((await store.get(upperAlias))?.id).toBe(upperAlias);
    expect((await store.get(lowerAlias))?.id).toBe(lowerAlias);
  });
});
