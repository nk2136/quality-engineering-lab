import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
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
});
