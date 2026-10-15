import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { bootstrapEditorMock } from '../src/editor-mock.js';
import { FileArtifactStore, FileWorkflowStore } from '../src/filesystem-stores.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('local editor workflow demo', () => {
  it('seeds a complete deterministic story-to-test artifact chain', async () => {
    const root = await mkdtemp(join(tmpdir(), 'qa-editor-demo-'));
    roots.push(root);

    const first = await bootstrapEditorMock(root);
    const second = await bootstrapEditorMock(root);
    const workflow = await new FileWorkflowStore(root).get(first.workflowId);
    const artifacts = await new FileArtifactStore(root).listByTrace(first.traceId);

    expect(second).toEqual(first);
    expect(workflow).toMatchObject({ stage: 'verification', status: 'completed', version: 7 });
    expect(artifacts).toHaveLength(8);
    expect(artifacts.map((item) => item.metadata.artifactRole).sort()).toEqual([
      'automation-plan', 'automation-review', 'discrepancy-report', 'readiness-package',
      'test-design', 'test-design-review', 'traceability-matrix', 'verification-report',
    ]);
    expect(artifacts.at(-1)?.content).toMatchObject({ state: 'completed', revision: 'mock-r1' });
  });
});
