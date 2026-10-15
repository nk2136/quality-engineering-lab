import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { FileArtifactStore, FileWorkflowStore } from './filesystem-stores.js';
import { HumanDecisionService } from './human-decisions.js';
import { LifecycleCoordinator } from './lifecycle-coordinator.js';

/** Explicit synthetic fixture; running the MCP server alone never creates workflows. */
export async function seedEditorMock(root: string) {
  const workflowId = 'mock/QE-42';
  const evidenceId = 'mock-QE-42-story';
  const workflows = new FileWorkflowStore(root);
  const artifacts = new FileArtifactStore(root);
  const decisions = new HumanDecisionService(workflows, artifacts);
  const existing = await workflows.get(workflowId);
  if (existing !== undefined) {
    const pending = await decisions.listPending(workflowId);
    return { workflowId, evidenceId, requestId: pending[0]?.id, version: existing.version, status: existing.status };
  }
  const coordinator = new LifecycleCoordinator(workflows);
  const workflow = await coordinator.start({ id: workflowId, traceId: 'b364b03e-88b0-4a8e-a9ea-99b5ea8077cf' });
  await artifacts.put({ id: evidenceId, traceId: workflow.traceId, kind: 'requirement-analysis', schemaVersion: '1.0',
    createdAt: '2026-09-30T00:00:00.000Z', metadata: { mode: 'local-mock' }, content: {
      mode: 'local-mock', storyKey: 'QE-42', revision: 'mock-r1',
      acceptanceCriteria: [{ id: 'AC-1', text: 'Inactive-member requests must be rejected.' }],
      openQuestion: 'Confirm the observable rejection behavior.',
      mockConfirmationExample: 'Mock Dev confirms the inactive request is rejected with the documented response.',
    } });
  const attached = await workflows.save({ ...workflow, artifactIds: [evidenceId] }, workflow.version);
  const request = await decisions.pause({ workflowId, expectedVersion: attached.version, reason: 'clarification',
    questions: [{ id: 'Q-1', acIds: ['AC-1'], owner: 'Mock Dev', question: 'Confirm the observable rejection behavior for inactive-member requests.', evidenceIds: [evidenceId] }] });
  return { workflowId, evidenceId, requestId: request.id, version: request.workflowVersion, status: 'waiting-for-human' };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const flag = process.argv.indexOf('--root');
  const root = resolve(flag === -1 ? '.qa-workflows' : process.argv[flag + 1] ?? '.qa-workflows');
  console.log(JSON.stringify(await seedEditorMock(root), null, 2));
}
