import { describe, expect, it } from 'vitest';
import { ConcurrencyConflictError, DuplicateRecordError, type ArtifactRecord, type WorkflowState } from '../src/contracts.js';
import { InMemoryArtifactStore, InMemoryWorkflowStore } from '../src/in-memory-stores.js';

const traceId = '3d594650-3436-4d7c-86a7-2b94788009bc';

function workflow(): WorkflowState {
  return {
    id: 'STORY-42',
    traceId,
    stage: 'refinement',
    status: 'pending',
    version: 0,
    updatedAt: '2026-08-26T20:00:00.000Z',
    artifactIds: [],
    approval: { status: 'pending', reviewer: null, reviewedAt: null },
  };
}

function artifact(id: string, createdAt: string): ArtifactRecord {
  return {
    id,
    traceId,
    kind: 'context-pack',
    schemaVersion: '1.0',
    createdAt,
    content: { objective: 'Assess STORY-42.' },
    metadata: { source: 'test' },
  };
}

describe('in-memory foundation stores', () => {
  it('uses optimistic concurrency and increments the persisted workflow version', async () => {
    const store = new InMemoryWorkflowStore();
    await store.create(workflow());

    const saved = await store.save({ ...workflow(), status: 'running' }, 0);

    expect(saved.version).toBe(1);
    expect((await store.get('STORY-42'))?.status).toBe('running');
    await expect(store.save(saved, 0)).rejects.toBeInstanceOf(ConcurrencyConflictError);
  });

  it('rejects duplicate workflow and artifact identifiers', async () => {
    const workflows = new InMemoryWorkflowStore();
    const artifacts = new InMemoryArtifactStore();
    await workflows.create(workflow());
    await artifacts.put(artifact('artifact-1', '2026-08-26T20:00:00.000Z'));

    await expect(workflows.create(workflow())).rejects.toBeInstanceOf(DuplicateRecordError);
    await expect(
      artifacts.put(artifact('artifact-1', '2026-08-26T20:01:00.000Z')),
    ).rejects.toBeInstanceOf(DuplicateRecordError);
  });

  it('returns defensive copies instead of mutable persisted references', async () => {
    const store = new InMemoryWorkflowStore();
    await store.create(workflow());

    const first = await store.get('STORY-42');
    first?.artifactIds.push('unpersisted-change');

    expect((await store.get('STORY-42'))?.artifactIds).toEqual([]);
  });

  it('lists trace artifacts in deterministic creation order', async () => {
    const store = new InMemoryArtifactStore();
    await store.put(artifact('later', '2026-08-26T20:02:00.000Z'));
    await store.put(artifact('earlier', '2026-08-26T20:01:00.000Z'));

    const result = await store.listByTrace(traceId);

    expect(result.map((item) => item.id)).toEqual(['earlier', 'later']);
  });
});
