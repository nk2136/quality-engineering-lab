import { access, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { WorkflowState } from '../../src/contracts.js';
import { FileWorkflowStore } from '../../src/filesystem-stores.js';

const [root, name, status] = process.argv.slice(2);
if (!root || !name || (status !== 'running' && status !== 'waiting-for-human')) {
  throw new Error('Expected root, name, and workflow status.');
}

const state: WorkflowState = {
  id: 'story/QE-42',
  traceId: '3d594650-3436-4d7c-86a7-2b94788009bc',
  stage: 'refinement',
  status,
  version: 0,
  updatedAt: '2026-09-29T12:00:00.000Z',
  artifactIds: Array.from({ length: 300_000 }, (_, index) => `artifact-${index}`),
  approval: { status: 'pending', reviewer: null, reviewedAt: null },
};

await writeFile(join(root, `ready-${name}`), 'ready', 'utf8');
while (true) {
  try {
    await access(join(root, 'go'));
    break;
  } catch {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

try {
  await new FileWorkflowStore(root).save(state, 0);
  process.stdout.write('success');
} catch (error) {
  process.stdout.write(
    error instanceof Error ? (error.name === 'Error' ? error.message : error.name) : 'unknown',
  );
}
