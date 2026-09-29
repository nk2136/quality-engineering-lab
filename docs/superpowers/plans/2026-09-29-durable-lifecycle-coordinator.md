# Durable Lifecycle Coordinator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a durable, deterministic workflow coordinator with atomic checkpoints, legal transitions, idempotent starts, bounded retries, cancellation, and restart recovery.

**Architecture:** Keep the existing `ArtifactStore` and `WorkflowStore` interfaces. Add filesystem implementations that validate every read and write, then place lifecycle policy in a small coordinator that delegates persistence through those interfaces. The coordinator remains agent-agnostic so later UI discovery, coverage, patch, review, approval, execution, and reporting stages can reuse it.

**Tech Stack:** TypeScript 5.9, Node.js 22 standard library, Zod 4, Vitest 3

---

## File map

- Modify `src/io.ts`: atomic JSON writing used by durable stores.
- Modify `src/contracts.ts`: add the explicit `blocked` terminal status and typed lifecycle errors.
- Create `src/filesystem-stores.ts`: filesystem implementations of existing stores.
- Create `src/lifecycle-coordinator.ts`: transition policy, idempotent start, retry, cancellation, and resume behavior.
- Create `tests/io.test.ts`: atomic write behavior.
- Create `tests/filesystem-stores.test.ts`: persistence, restart, validation, duplicates, and concurrency.
- Create `tests/lifecycle-coordinator.test.ts`: legal transitions, invalid transitions, idempotency, retries, cancellation, and recovery.

### Task 1: Atomic JSON checkpoints

**Files:**
- Modify: `src/io.ts`
- Create: `tests/io.test.ts`

- [ ] **Step 1: Write failing atomic-write tests**

Create `tests/io.test.ts`:

```ts
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readJson, writeJsonAtomic } from '../src/io.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('atomic JSON I/O', () => {
  it('creates parent directories and writes parseable formatted JSON', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'qe-io-'));
    directories.push(directory);
    const path = join(directory, 'nested', 'state.json');

    await writeJsonAtomic(path, { version: 1, status: 'pending' });

    expect(await readJson(path)).toEqual({ version: 1, status: 'pending' });
    expect(await readFile(path, 'utf8')).toBe('{\n  "version": 1,\n  "status": "pending"\n}\n');
  });

  it('replaces an existing checkpoint without leaving a temporary file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'qe-io-'));
    directories.push(directory);
    const path = join(directory, 'state.json');

    await writeJsonAtomic(path, { version: 1 });
    await writeJsonAtomic(path, { version: 2 });

    expect(await readJson(path)).toEqual({ version: 2 });
    await expect(readFile(`${path}.tmp`, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
```

- [ ] **Step 2: Run the tests and verify the missing export fails**

Run:

```powershell
npx vitest run tests/io.test.ts
```

Expected: FAIL because `writeJsonAtomic` is not exported.

- [ ] **Step 3: Implement atomic JSON replacement with the Node standard library**

Update `src/io.ts`:

```ts
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8')) as unknown;
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const temporaryPath = `${path}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await rename(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}
```

- [ ] **Step 4: Verify the focused tests pass**

Run:

```powershell
npx vitest run tests/io.test.ts
```

Expected: 2 tests pass.

- [ ] **Step 5: Commit the atomic I/O change**

```powershell
git add src/io.ts tests/io.test.ts
git commit -m "feat: write workflow checkpoints atomically"
```

### Task 2: Durable filesystem stores

**Files:**
- Create: `src/filesystem-stores.ts`
- Create: `tests/filesystem-stores.test.ts`

- [ ] **Step 1: Write failing persistence and conflict tests**

Create `tests/filesystem-stores.test.ts` with helpers matching `tests/stores.test.ts`, then add these cases:

```ts
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
  it('persists workflows and artifacts across store instances', async () => {
    const path = await root();
    await new FileWorkflowStore(path).create(workflow());
    await new FileArtifactStore(path).put(artifact());

    expect(await new FileWorkflowStore(path).get('story/QE-42')).toEqual(workflow());
    expect(await new FileArtifactStore(path).get('context/QE-42')).toEqual(artifact());
  });

  it('rejects duplicates and stale workflow versions', async () => {
    const path = await root();
    const workflows = new FileWorkflowStore(path);
    const artifacts = new FileArtifactStore(path);
    await workflows.create(workflow());
    await artifacts.put(artifact());

    await expect(workflows.create(workflow())).rejects.toBeInstanceOf(DuplicateRecordError);
    await expect(artifacts.put(artifact())).rejects.toBeInstanceOf(DuplicateRecordError);
    const saved = await workflows.save({ ...workflow(), status: 'running' }, 0);
    await expect(workflows.save(saved, 0)).rejects.toBeInstanceOf(ConcurrencyConflictError);
  });

  it('validates persisted data when it is read', async () => {
    const path = await root();
    const store = new FileWorkflowStore(path);
    await store.create(workflow());
    const recordPath = store.pathFor('story/QE-42');
    await writeFile(recordPath, '{"status":"invented"}\n', 'utf8');

    await expect(store.get('story/QE-42')).rejects.toThrow();
  });

  it('lists trace artifacts in deterministic creation order', async () => {
    const path = await root();
    const store = new FileArtifactStore(path);
    await store.put({ ...artifact('later'), createdAt: '2026-09-29T12:02:00.000Z' });
    await store.put({ ...artifact('earlier'), createdAt: '2026-09-29T12:01:00.000Z' });

    expect((await store.listByTrace(traceId)).map(({ id }) => id)).toEqual(['earlier', 'later']);
  });
});
```

- [ ] **Step 2: Run the tests and verify the missing module fails**

Run:

```powershell
npx vitest run tests/filesystem-stores.test.ts
```

Expected: FAIL because `src/filesystem-stores.ts` does not exist.

- [ ] **Step 3: Implement path-safe filesystem stores**

Create `src/filesystem-stores.ts`. Use `Buffer.from(id).toString('base64url')` for filenames, `readJson` for reads, `writeJsonAtomic` for saves, `open(path, 'wx')` for duplicate-safe creates, and the existing Zod schemas for every boundary. Export:

```ts
export class FileArtifactStore implements ArtifactStore {
  constructor(private readonly root: string) {}
  pathFor(id: string): string;
  put(artifact: ArtifactRecord): Promise<void>;
  get(id: string): Promise<ArtifactRecord | undefined>;
  listByTrace(traceId: string): Promise<readonly ArtifactRecord[]>;
}

export class FileWorkflowStore implements WorkflowStore {
  constructor(private readonly root: string) {}
  pathFor(id: string): string;
  create(state: WorkflowState): Promise<void>;
  get(id: string): Promise<WorkflowState | undefined>;
  save(state: WorkflowState, expectedVersion: number): Promise<WorkflowState>;
}
```

Implement a private `readOptional` helper that returns `undefined` only for `ENOENT`. All other filesystem and validation errors must propagate. `save` must read and validate the current record, compare both the persisted and submitted versions to `expectedVersion`, increment once, validate again, and atomically replace the record.

- [ ] **Step 4: Verify focused and existing store tests**

Run:

```powershell
npx vitest run tests/filesystem-stores.test.ts tests/stores.test.ts
```

Expected: all filesystem and in-memory store tests pass.

- [ ] **Step 5: Commit durable stores**

```powershell
git add src/filesystem-stores.ts tests/filesystem-stores.test.ts
git commit -m "feat: persist workflow artifacts on filesystem"
```

### Task 3: Explicit blocked state and lifecycle errors

**Files:**
- Modify: `src/contracts.ts`
- Modify: `tests/schemas.test.ts`

- [ ] **Step 1: Add failing schema assertions**

Add to `tests/schemas.test.ts`:

```ts
it('accepts an explicit blocked workflow terminal state', () => {
  expect(WorkflowStateSchema.parse({
    id: 'QE-42',
    traceId: '3d594650-3436-4d7c-86a7-2b94788009bc',
    stage: 'planning',
    status: 'blocked',
    version: 2,
    updatedAt: '2026-09-29T12:00:00.000Z',
    artifactIds: [],
    approval: { status: 'pending', reviewer: null, reviewedAt: null },
  }).status).toBe('blocked');
});
```

- [ ] **Step 2: Verify the new status is rejected**

Run:

```powershell
npx vitest run tests/schemas.test.ts
```

Expected: FAIL because `blocked` is not in the status enum.

- [ ] **Step 3: Extend the status schema and add typed coordinator errors**

Add `blocked` to `WorkflowStateSchema.status`. Add these exports beside the existing store errors:

```ts
export class InvalidTransitionError extends Error {
  constructor(from: WorkflowStage, to: WorkflowStage) {
    super(`Workflow cannot transition from '${from}' to '${to}'.`);
    this.name = 'InvalidTransitionError';
  }
}

export class WorkflowCancelledError extends Error {
  constructor(id: string) {
    super(`Workflow '${id}' was cancelled.`);
    this.name = 'WorkflowCancelledError';
  }
}

export class RetryExhaustedError extends Error {
  constructor(id: string, attempts: number, options?: ErrorOptions) {
    super(`Workflow '${id}' exhausted ${attempts} attempts.`, options);
    this.name = 'RetryExhaustedError';
  }
}
```

- [ ] **Step 4: Run schema and type checks**

Run:

```powershell
npm run typecheck
npx vitest run tests/schemas.test.ts tests/stores.test.ts tests/filesystem-stores.test.ts
```

Expected: typecheck and all selected tests pass.

- [ ] **Step 5: Commit lifecycle contract changes**

```powershell
git add src/contracts.ts tests/schemas.test.ts
git commit -m "feat: define blocked workflow lifecycle state"
```

### Task 4: Deterministic lifecycle coordinator

**Files:**
- Create: `src/lifecycle-coordinator.ts`
- Create: `tests/lifecycle-coordinator.test.ts`

- [ ] **Step 1: Write failing coordinator tests**

Create `tests/lifecycle-coordinator.test.ts` using `InMemoryWorkflowStore`. Cover:

```ts
it('starts idempotently for the same id and trace', async () => {
  const first = await coordinator.start(input);
  const second = await coordinator.start(input);
  expect(second).toEqual(first);
});

it('permits only declared forward transitions', async () => {
  await coordinator.start(input);
  expect((await coordinator.transition(input.id, 'planning')).stage).toBe('planning');
  await expect(coordinator.transition(input.id, 'release')).rejects.toBeInstanceOf(
    InvalidTransitionError,
  );
});

it('retries a retryable handoff within the configured bound', async () => {
  await coordinator.start(input);
  let attempts = 0;
  const result = await coordinator.run(input.id, 'planning', async () => {
    attempts += 1;
    if (attempts < 3) throw new Error('temporary');
    return ['artifact-1'];
  }, { maxAttempts: 3, retryable: () => true });
  expect(attempts).toBe(3);
  expect(result.artifactIds).toEqual(['artifact-1']);
});

it('blocks after retry exhaustion', async () => {
  await coordinator.start(input);
  await expect(coordinator.run(input.id, 'planning', async () => {
    throw new Error('still failing');
  }, { maxAttempts: 2, retryable: () => true })).rejects.toBeInstanceOf(RetryExhaustedError);
  expect(await coordinator.resume(input.id)).toMatchObject({ status: 'blocked', stage: 'refinement' });
});

it('cancels and refuses further handoffs', async () => {
  await coordinator.start(input);
  await coordinator.cancel(input.id);
  await expect(coordinator.run(input.id, 'planning', async () => [])).rejects.toBeInstanceOf(
    WorkflowCancelledError,
  );
});

it('resumes the latest persisted checkpoint with a new coordinator instance', async () => {
  const started = await coordinator.start(input);
  await coordinator.transition(started.id, 'planning');
  expect(await new LifecycleCoordinator(store, now).resume(started.id)).toMatchObject({
    stage: 'planning',
    status: 'pending',
    version: 1,
  });
});
```

Use a fixed `now` function and the seven existing `WorkflowStage` values. The legal transition map is refinement → planning → implementation → verification → triage → release → production.

- [ ] **Step 2: Run and verify the missing coordinator fails**

Run:

```powershell
npx vitest run tests/lifecycle-coordinator.test.ts
```

Expected: FAIL because `src/lifecycle-coordinator.ts` does not exist.

- [ ] **Step 3: Implement the minimal coordinator**

Create `src/lifecycle-coordinator.ts` with:

```ts
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

export class LifecycleCoordinator {
  constructor(
    private readonly workflows: WorkflowStore,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  start(input: StartWorkflowInput): Promise<WorkflowState>;
  resume(id: string): Promise<WorkflowState>;
  transition(id: string, to: WorkflowStage, artifactIds?: readonly string[]): Promise<WorkflowState>;
  run(
    id: string,
    to: WorkflowStage,
    handoff: () => Promise<readonly string[]>,
    options?: RunOptions,
  ): Promise<WorkflowState>;
  cancel(id: string): Promise<WorkflowState>;
}
```

`start` returns an existing record only when its trace ID matches; an existing ID with another trace throws `DuplicateRecordError`. `resume` throws a clear error when the record does not exist. `transition` checks the declared next stage, refuses terminal states, appends unique artifact IDs, sets `pending`, updates time, and relies on optimistic version save. `run` sets `running`, invokes the handoff up to `maxAttempts` (default 1), checks cancellation before each attempt, transitions only after success, and persists `blocked` after retry exhaustion. `cancel` is idempotent and persists `cancelled` once.

- [ ] **Step 4: Verify coordinator behavior**

Run:

```powershell
npx vitest run tests/lifecycle-coordinator.test.ts
```

Expected: all coordinator tests pass.

- [ ] **Step 5: Commit the coordinator**

```powershell
git add src/lifecycle-coordinator.ts tests/lifecycle-coordinator.test.ts
git commit -m "feat: coordinate durable workflow lifecycle"
```

### Task 5: Restart and full regression verification

**Files:**
- Modify: `tests/lifecycle-coordinator.test.ts`
- Modify: `README.md`

- [ ] **Step 1: Add the filesystem restart acceptance test**

Add a test that starts and advances a workflow through `LifecycleCoordinator` with `FileWorkflowStore`, creates a new store and coordinator pointed at the same temporary root, resumes the workflow, cancels it, creates a third coordinator, and confirms the cancelled terminal state persists.

- [ ] **Step 2: Run the acceptance test before documentation changes**

Run:

```powershell
npx vitest run tests/lifecycle-coordinator.test.ts -t "persists lifecycle state across coordinator restarts"
```

Expected: PASS.

- [ ] **Step 3: Update the README status accurately**

In `README.md`, mark only the durable lifecycle coordinator roadmap item complete. Add a short “Durable workflow checkpoints” paragraph showing that filesystem persistence is available through `FileWorkflowStore` and `FileArtifactStore`, while the current Story Readiness command still uses its existing wiring until the next vertical-slice plan connects it.

- [ ] **Step 4: Run the complete deterministic verification**

Run:

```powershell
npm run check
git diff --check
```

Expected: TypeScript succeeds, every Vitest test passes, and `git diff --check` prints nothing.

- [ ] **Step 5: Commit milestone completion**

```powershell
git add tests/lifecycle-coordinator.test.ts README.md
git commit -m "docs: record durable lifecycle milestone"
```

## Follow-on plan sequence

After this plan passes, create and execute separate plans in this order:

1. Local demo application plus UI Discovery Agent and locator evidence.
2. Pinned repository inventory plus requirement-to-coverage matrix.
3. Mock model gateway, bounded Playwright patch generation, and independent review.
4. Hash-bound human approval plus local executor and failure triage.
5. Evidence reporting, PostgreSQL/OpenAPI/CI/telemetry mock adapters, flaky analysis, defect drafting, and release-risk summary.
6. Full end-to-end acceptance cases, CLI integration, documentation, and roadmap reconciliation.
