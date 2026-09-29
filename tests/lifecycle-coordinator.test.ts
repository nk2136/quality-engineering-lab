import { describe, expect, it } from 'vitest';
import {
  ConcurrencyConflictError,
  DuplicateRecordError,
  InvalidTransitionError,
  RetryExhaustedError,
  WorkflowCancelledError,
  type WorkflowState,
  type WorkflowStore,
} from '../src/contracts.js';
import { InMemoryWorkflowStore } from '../src/in-memory-stores.js';
import { LifecycleCoordinator } from '../src/lifecycle-coordinator.js';

const traceId = '3d594650-3436-4d7c-86a7-2b94788009bc';
const otherTraceId = '66d2283c-30f5-46eb-b76c-8e87cb658e22';
const firstTime = '2026-09-29T12:00:00.000Z';
const secondTime = '2026-09-29T12:01:00.000Z';

function coordinator(store = new InMemoryWorkflowStore(), now = () => firstTime) {
  return { store, coordinator: new LifecycleCoordinator(store, now) };
}

function state(overrides: Partial<WorkflowState> = {}): WorkflowState {
  return {
    id: 'STORY-42',
    traceId,
    stage: 'refinement',
    status: 'pending',
    version: 0,
    updatedAt: firstTime,
    artifactIds: [],
    approval: { status: 'pending', reviewer: null, reviewedAt: null },
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

describe('LifecycleCoordinator', () => {
  it('starts a validated workflow with lifecycle defaults', async () => {
    const { coordinator: lifecycle } = coordinator();

    await expect(lifecycle.start({ id: 'STORY-42', traceId })).resolves.toEqual(state());
    await expect(
      lifecycle.start({
        id: 'STORY-43',
        traceId: otherTraceId,
        stage: 'planning',
        approvalRequired: false,
      }),
    ).resolves.toMatchObject({
      id: 'STORY-43',
      traceId: otherTraceId,
      stage: 'planning',
      status: 'pending',
      version: 0,
      updatedAt: firstTime,
      approval: { status: 'not-required', reviewer: null, reviewedAt: null },
    });
  });

  it('returns the unchanged persisted workflow for an idempotent start', async () => {
    const { coordinator: lifecycle } = coordinator();
    const original = await lifecycle.start({ id: 'STORY-42', traceId });
    const advanced = await lifecycle.transition('STORY-42', 'planning');

    expect(await lifecycle.start({ id: 'STORY-42', traceId })).toEqual(advanced);
    expect(advanced).not.toEqual(original);
  });

  it('rejects a reused workflow id with a different trace', async () => {
    const { coordinator: lifecycle } = coordinator();
    await lifecycle.start({ id: 'STORY-42', traceId });

    await expect(lifecycle.start({ id: 'STORY-42', traceId: otherTraceId })).rejects.toBeInstanceOf(
      DuplicateRecordError,
    );
  });

  it('makes concurrent starts for the same id and trace idempotent', async () => {
    const store = new InMemoryWorkflowStore();
    const first = new LifecycleCoordinator(store, () => firstTime);
    const second = new LifecycleCoordinator(store, () => secondTime);

    const results = await Promise.allSettled([
      first.start({ id: 'STORY-42', traceId }),
      second.start({ id: 'STORY-42', traceId }),
    ]);

    expect(results).toEqual([
      { status: 'fulfilled', value: state() },
      { status: 'fulfilled', value: state() },
    ]);
    expect(await store.get('STORY-42')).toEqual(state());
  });

  it('validates start identifiers, trace UUIDs, and stages', async () => {
    const { coordinator: lifecycle } = coordinator();

    await expect(lifecycle.start({ id: '', traceId })).rejects.toThrow();
    await expect(lifecycle.start({ id: 'STORY-42', traceId: 'not-a-uuid' })).rejects.toThrow();
    await expect(
      lifecycle.start({ id: 'STORY-42', traceId, stage: 'unknown' as never }),
    ).rejects.toThrow();
  });

  it('rejects invalid start options before creating a workflow', async () => {
    const { coordinator: lifecycle } = coordinator();

    await expect(
      lifecycle.start({ id: 'STORY-42', traceId, approvalRequired: 'false' as never }),
    ).rejects.toThrow();
    await expect(lifecycle.resume('STORY-42')).rejects.toThrow(
      "Workflow 'STORY-42' does not exist.",
    );
  });

  it('resumes the latest checkpoint through a newly constructed coordinator', async () => {
    const store = new InMemoryWorkflowStore();
    const first = new LifecycleCoordinator(store, () => firstTime);
    await first.start({ id: 'STORY-42', traceId });
    const checkpoint = await first.transition('STORY-42', 'planning');

    await expect(new LifecycleCoordinator(store).resume('STORY-42')).resolves.toEqual(checkpoint);
  });

  it('validates resume ids and reports missing workflows clearly', async () => {
    const { coordinator: lifecycle } = coordinator();

    await expect(lifecycle.resume('')).rejects.toThrow();
    await expect(lifecycle.resume('missing')).rejects.toThrow("Workflow 'missing' does not exist.");
  });

  it('permits each exact next stage and rejects skips, backward, and same-stage transitions', async () => {
    const { coordinator: lifecycle } = coordinator();
    await lifecycle.start({ id: 'STORY-42', traceId });
    for (const next of [
      'planning',
      'implementation',
      'verification',
      'triage',
      'release',
      'production',
    ] as const) {
      await expect(lifecycle.transition('STORY-42', next)).resolves.toMatchObject({ stage: next });
    }
    await expect(lifecycle.transition('STORY-42', 'production')).rejects.toBeInstanceOf(
      InvalidTransitionError,
    );

    const fresh = coordinator().coordinator;
    await fresh.start({ id: 'STORY-43', traceId });
    await expect(fresh.transition('STORY-43', 'implementation')).rejects.toBeInstanceOf(
      InvalidTransitionError,
    );
    await fresh.transition('STORY-43', 'planning');
    await expect(fresh.transition('STORY-43', 'refinement')).rejects.toBeInstanceOf(
      InvalidTransitionError,
    );
  });

  it.each(['completed', 'failed', 'cancelled', 'blocked'] as const)(
    'refuses transitions from %s workflows',
    async (status) => {
      const store = new InMemoryWorkflowStore();
      await store.create(state({ status }));
      const lifecycle = new LifecycleCoordinator(store);

      await expect(lifecycle.transition('STORY-42', 'planning')).rejects.toThrow(
        `Workflow 'STORY-42' cannot transition while status is '${status}'.`,
      );
    },
  );

  it('transitions to pending, updates time, and appends unique artifacts in input order', async () => {
    const store = new InMemoryWorkflowStore();
    await store.create(state({ status: 'running', artifactIds: ['existing'] }));
    const lifecycle = new LifecycleCoordinator(store, () => secondTime);

    await expect(
      lifecycle.transition('STORY-42', 'planning', ['new-2', 'existing', 'new-1', 'new-2']),
    ).resolves.toEqual(
      state({
        stage: 'planning',
        status: 'pending',
        version: 1,
        updatedAt: secondTime,
        artifactIds: ['existing', 'new-2', 'new-1'],
      }),
    );
  });

  it('saves a running checkpoint before handoff and a pending target with its artifacts after', async () => {
    const { coordinator: lifecycle } = coordinator();
    await lifecycle.start({ id: 'STORY-42', traceId });
    let duringHandoff: WorkflowState | undefined;

    const result = await lifecycle.run('STORY-42', 'planning', async () => {
      duringHandoff = await lifecycle.resume('STORY-42');
      return ['artifact-1', 'artifact-2'];
    });

    expect(duringHandoff).toMatchObject({ stage: 'refinement', status: 'running', version: 1 });
    expect(result).toMatchObject({
      stage: 'planning',
      status: 'pending',
      version: 2,
      artifactIds: ['artifact-1', 'artifact-2'],
    });
  });

  it('validates maxAttempts as a positive integer before running', async () => {
    const { coordinator: lifecycle } = coordinator();
    await lifecycle.start({ id: 'STORY-42', traceId });

    await expect(
      lifecycle.run('STORY-42', 'planning', async () => [], { maxAttempts: 0 }),
    ).rejects.toThrow();
    await expect(
      lifecycle.run('STORY-42', 'planning', async () => [], { maxAttempts: 1.5 }),
    ).rejects.toThrow();
    expect(await lifecycle.resume('STORY-42')).toEqual(state());
  });

  it('rejects a non-function retry predicate before running or calling handoff', async () => {
    const { coordinator: lifecycle } = coordinator();
    await lifecycle.start({ id: 'STORY-42', traceId });
    let handoffCalled = false;

    await expect(
      lifecycle.run(
        'STORY-42',
        'planning',
        async () => {
          handoffCalled = true;
          return [];
        },
        { retryable: 'not-a-function' as never },
      ),
    ).rejects.toThrow();
    expect(handoffCalled).toBe(false);
    expect(await lifecycle.resume('STORY-42')).toEqual(state());
  });

  it('retries retryable handoff failures up to the configured attempt count', async () => {
    const { coordinator: lifecycle } = coordinator();
    await lifecycle.start({ id: 'STORY-42', traceId });
    let attempts = 0;

    const result = await lifecycle.run(
      'STORY-42',
      'planning',
      async () => {
        attempts += 1;
        if (attempts < 3) throw new Error('temporary');
        return ['artifact-1'];
      },
      { maxAttempts: 3, retryable: () => true },
    );

    expect(attempts).toBe(3);
    expect(result).toMatchObject({ stage: 'planning', status: 'pending' });
  });

  it('checks for cancellation before starting the next retry attempt', async () => {
    const inner = new InMemoryWorkflowStore();
    let cancelBeforeNextRead = false;
    const store: WorkflowStore = {
      create: (value) => inner.create(value),
      save: (value, version) => inner.save(value, version),
      get: async (id) => {
        const current = await inner.get(id);
        if (cancelBeforeNextRead && current?.status === 'running') {
          cancelBeforeNextRead = false;
          return inner.save({ ...current, status: 'cancelled' }, current.version);
        }
        return current;
      },
    };
    const lifecycle = new LifecycleCoordinator(store, () => firstTime);
    await lifecycle.start({ id: 'STORY-42', traceId });
    let attempts = 0;

    await expect(
      lifecycle.run(
        'STORY-42',
        'planning',
        async () => {
          attempts += 1;
          throw new Error('temporary');
        },
        {
          maxAttempts: 3,
          retryable: () => {
            cancelBeforeNextRead = true;
            return true;
          },
        },
      ),
    ).rejects.toBeInstanceOf(WorkflowCancelledError);
    expect(attempts).toBe(1);
    expect(await inner.get('STORY-42')).toMatchObject({ status: 'cancelled', version: 2 });
  });

  it('rejects stale handoff completion without overwriting newer workflow progress', async () => {
    const store = new InMemoryWorkflowStore();
    const runner = new LifecycleCoordinator(store, () => firstTime);
    const concurrent = new LifecycleCoordinator(store, () => secondTime);
    await runner.start({ id: 'STORY-42', traceId });
    const handoff = deferred<readonly string[]>();
    const handoffStarted = deferred<void>();
    const running = runner.run('STORY-42', 'planning', async () => {
      handoffStarted.resolve();
      return handoff.promise;
    });
    await handoffStarted.promise;
    await concurrent.transition('STORY-42', 'planning');
    const implementation = await concurrent.transition('STORY-42', 'implementation');

    handoff.resolve(['artifact-1']);

    await expect(running).rejects.toBeInstanceOf(ConcurrencyConflictError);
    expect(await runner.resume('STORY-42')).toEqual(implementation);
  });

  it('settles malformed handoff artifact ids as failed', async () => {
    const { coordinator: lifecycle } = coordinator();
    await lifecycle.start({ id: 'STORY-42', traceId });
    let attempts = 0;

    await expect(
      lifecycle.run(
        'STORY-42',
        'planning',
        async () => {
          attempts += 1;
          return [''];
        },
        { maxAttempts: 3, retryable: () => true },
      ),
    ).rejects.toThrow();
    expect(attempts).toBe(1);
    await expect(lifecycle.resume('STORY-42')).resolves.toMatchObject({
      stage: 'refinement',
      status: 'failed',
      version: 2,
    });
  });

  it('settles retry predicate failures as failed and retains the handoff error as cause', async () => {
    const { coordinator: lifecycle } = coordinator();
    await lifecycle.start({ id: 'STORY-42', traceId });
    const handoffError = new Error('handoff failed');
    const predicateError = new Error('predicate failed');

    let thrown: unknown;
    try {
      await lifecycle.run(
        'STORY-42',
        'planning',
        async () => {
          throw handoffError;
        },
        {
          retryable: () => {
            throw predicateError;
          },
        },
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe('predicate failed');
    expect((thrown as Error).cause).toBe(handoffError);
    await expect(lifecycle.resume('STORY-42')).resolves.toMatchObject({
      stage: 'refinement',
      status: 'failed',
      version: 2,
    });
  });

  it.each([
    ['async false', async () => false],
    ['string yes', () => 'yes'],
  ])(
    'rejects a non-boolean %s retry predicate result and settles failed',
    async (_label, retryable) => {
      const { coordinator: lifecycle } = coordinator();
      await lifecycle.start({ id: 'STORY-42', traceId });
      const handoffError = new Error('handoff failed');
      let attempts = 0;
      let thrown: unknown;

      try {
        await lifecycle.run(
          'STORY-42',
          'planning',
          async () => {
            attempts += 1;
            throw handoffError;
          },
          { maxAttempts: 3, retryable: retryable as never },
        );
      } catch (error) {
        thrown = error;
      }

      expect(attempts).toBe(1);
      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).cause).toBe(handoffError);
      await expect(lifecycle.resume('STORY-42')).resolves.toMatchObject({
        stage: 'refinement',
        status: 'failed',
        version: 2,
      });
    },
  );

  it('handles an asynchronously rejected retry predicate without a detached rejection', async () => {
    const { coordinator: lifecycle } = coordinator();
    await lifecycle.start({ id: 'STORY-42', traceId });
    const handoffError = new Error('handoff failed');
    const predicateError = new Error('predicate rejected');
    const unhandled: unknown[] = [];
    const onUnhandled = (error: unknown) => unhandled.push(error);
    process.on('unhandledRejection', onUnhandled);
    let attempts = 0;

    try {
      let thrown: unknown;
      try {
        await lifecycle.run(
          'STORY-42',
          'planning',
          async () => {
            attempts += 1;
            throw handoffError;
          },
          {
            maxAttempts: 3,
            retryable: (async () => {
              throw predicateError;
            }) as never,
          },
        );
      } catch (error) {
        thrown = error;
      }
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(attempts).toBe(1);
      expect(thrown).toBeInstanceOf(AggregateError);
      expect((thrown as AggregateError).errors).toContain(predicateError);
      expect((thrown as Error).cause).toBe(handoffError);
      expect(unhandled).toEqual([]);
      await expect(lifecycle.resume('STORY-42')).resolves.toMatchObject({
        stage: 'refinement',
        status: 'failed',
        version: 2,
      });
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('rethrows a non-retryable failure and persists failed state without losing artifacts', async () => {
    const store = new InMemoryWorkflowStore();
    await store.create(state({ artifactIds: ['existing'] }));
    const lifecycle = new LifecycleCoordinator(store);
    const failure = new Error('permanent');

    await expect(
      lifecycle.run('STORY-42', 'planning', async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    await expect(lifecycle.resume('STORY-42')).resolves.toMatchObject({
      stage: 'refinement',
      status: 'failed',
      version: 2,
      artifactIds: ['existing'],
    });
  });

  it('blocks after retry exhaustion and exposes the last failure as the cause', async () => {
    const { coordinator: lifecycle } = coordinator();
    await lifecycle.start({ id: 'STORY-42', traceId });
    const last = new Error('still temporary');

    let thrown: unknown;
    try {
      await lifecycle.run('STORY-42', 'planning', async () => {
        throw last;
      }, { maxAttempts: 2, retryable: () => true });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(RetryExhaustedError);
    expect((thrown as Error).cause).toBe(last);
    await expect(lifecycle.resume('STORY-42')).resolves.toMatchObject({
      stage: 'refinement',
      status: 'blocked',
      version: 2,
    });
  });

  it('cancels once idempotently and refuses to run a cancelled workflow', async () => {
    const { coordinator: lifecycle } = coordinator();
    await lifecycle.start({ id: 'STORY-42', traceId });

    const cancelled = await lifecycle.cancel('STORY-42');
    expect(await lifecycle.cancel('STORY-42')).toEqual(cancelled);
    expect(cancelled).toMatchObject({ status: 'cancelled', version: 1 });
    await expect(
      lifecycle.run('STORY-42', 'planning', async () => []),
    ).rejects.toBeInstanceOf(WorkflowCancelledError);
  });

  it('stops retrying when cancellation happens between attempts', async () => {
    const { coordinator: lifecycle } = coordinator();
    await lifecycle.start({ id: 'STORY-42', traceId });
    let attempts = 0;

    await expect(
      lifecycle.run(
        'STORY-42',
        'planning',
        async () => {
          attempts += 1;
          await lifecycle.cancel('STORY-42');
          throw new Error('temporary');
        },
        { maxAttempts: 3, retryable: () => true },
      ),
    ).rejects.toBeInstanceOf(WorkflowCancelledError);
    expect(attempts).toBe(1);
    await expect(lifecycle.resume('STORY-42')).resolves.toMatchObject({
      status: 'cancelled',
      version: 2,
    });
  });

  it('allows only one concurrent optimistic transition to win', async () => {
    const store = new InMemoryWorkflowStore();
    const first = new LifecycleCoordinator(store);
    const second = new LifecycleCoordinator(store);
    await first.start({ id: 'STORY-42', traceId });

    const results = await Promise.allSettled([
      first.transition('STORY-42', 'planning'),
      second.transition('STORY-42', 'planning'),
    ]);

    expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(({ status }) => status === 'rejected')).toHaveLength(1);
    expect(results.find(({ status }) => status === 'rejected')).toMatchObject({
      reason: expect.toSatisfy(
        (error: unknown) =>
          error instanceof ConcurrencyConflictError || error instanceof InvalidTransitionError,
      ),
    });
  });
});
