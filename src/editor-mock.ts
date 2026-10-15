import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { FileArtifactStore, FileWorkflowStore } from './filesystem-stores.js';
import { StoryToTestWorkflowService } from './workflow-services.js';
import { HumanDecisionService } from './human-decisions.js';
import { LifecycleCoordinator } from './lifecycle-coordinator.js';

const traceId = 'b364b03e-88b0-4a8e-a9ea-99b5ea8077cf';
const revision = 'mock-r1';
const asOf = '2026-10-15T12:00:00.000Z';
const workflowId = 'mock/QE-42';

function evidence(id: string, source: 'jira' | 'github' | 'test', content: string) {
  return { id, source, uri: `mock://${id}`, revision, retrievedAt: asOf, content, estimatedTokens: 10, relevance: 1 };
}

const profile = {
  frameworkConventions: { testRunner: 'vitest', testFilePatterns: ['tests/**/*.test.ts'], testDirectory: 'tests' },
  testConventions: ['BDD Given When Then'], interactionModel: 'framework-neutral',
  dataRules: { syntheticDataOnly: true, secretsAllowed: false, allowedDataSources: ['fixtures', 'mocks', 'local-artifacts'] },
};

/** Seed the small paused fixture used by MCP contract tests and human-gate demos. */
export async function seedEditorMock(root: string) {
  const artifacts = new FileArtifactStore(root);
  const workflows = new FileWorkflowStore(root);
  const decisions = new HumanDecisionService(workflows, artifacts, () => asOf);
  const existing = await workflows.get(workflowId);
  if (existing) {
    const pending = await decisions.listPending(workflowId);
    return { workflowId, evidenceId: 'mock-QE-42-story', requestId: pending[0]?.id, version: existing.version, status: existing.status };
  }
  const workflow = await new LifecycleCoordinator(workflows).start({ id: workflowId, traceId });
  const evidenceId = 'mock-QE-42-story';
  await artifacts.put({ id: evidenceId, traceId, kind: 'requirement-analysis', schemaVersion: '1.0', createdAt: asOf, metadata: { mode: 'local-mock' }, content: { storyKey: 'QE-42', revision, acceptanceCriteria: [{ id: 'AC-1', text: 'Inactive-member requests are rejected.' }] } });
  const attached = await workflows.save({ ...workflow, artifactIds: [evidenceId] }, workflow.version);
  const request = await decisions.pause({ workflowId, expectedVersion: attached.version, reason: 'clarification', questions: [{ id: 'Q-1', acIds: ['AC-1'], owner: 'product', question: 'Confirm observable rejection behavior.', evidenceIds: [evidenceId] }] });
  return { workflowId, evidenceId, requestId: request.id, version: attached.version + 1, status: 'waiting-for-human' as const };
}

/** Seed the complete local story-to-test chain. It never uses credentials, network, or production files. */
export async function bootstrapEditorMock(root: string) {
  const artifacts = new FileArtifactStore(root);
  const workflows = new FileWorkflowStore(root);
  const service = new StoryToTestWorkflowService({
    artifacts, workflows, now: () => asOf,
    requirements: {
      ticket: { search: async () => [evidence('mock-QE-42-ticket', 'jira', JSON.stringify({ key: 'QE-42', summary: 'Reject inactive members', acceptanceCriteria: ['Inactive members receive rejection.'], component: 'membership-service' }))] },
      history: { search: async () => [evidence('mock-QE-42-history', 'jira', JSON.stringify({ summary: 'Earlier membership validation', relevance: 'Confirms rejection is a user-visible behavior.' }))] },
      source: { search: async () => [evidence('mock-QE-42-source', 'github', JSON.stringify({ component: 'membership-service', branch: 'main', revision, files: ['src/membership.ts'] }))] },
      tests: { search: async () => [evidence('mock-QE-42-test', 'test', JSON.stringify({ path: 'tests/membership.test.ts', covers: ['Inactive members receive rejection.'] }))] },
    },
    execute: async () => ({ stdout: '8 passed', stderr: '', exitCode: 0, timedOut: false, triage: { category: 'success' as const, evidence: '' } }),
  });
  const existing = await workflows.get(workflowId);
  if (existing) return { workflowId, traceId, revision, status: existing.status, version: existing.version };
  const workflow = await service.coordinator.start({ id: workflowId, traceId, approvalRequired: false });
  const investigated = await service.investigateRequirements({ workflowId, traceId, storyKey: 'QE-42', sourceRevision: revision, asOf });
  const design = await service.designTests({ workflowId, readinessPackage: investigated.readinessPackage, projectProfile: profile });
  await service.reviewTestDesign({ workflowId, readinessPackage: investigated.readinessPackage, design: design.value });
  const plan = await service.planAutomation({ workflowId, design: design.value, readinessPackage: investigated.readinessPackage, projectProfile: profile, repositoryInventory: [
    { path: 'tests/membership.test.ts', revision, kind: 'test' }, { path: 'tests/fixtures/membership.ts', revision, kind: 'fixture' },
  ] });
  const diff = 'diff --git a/tests/membership.test.ts b/tests/membership.test.ts\n+++ b/tests/membership.test.ts\n@@ -1,1 +1,2 @@\n+test("rejects inactive members", () => expect(true).toBe(true));';
  const automationReview = await service.reviewAutomation({ workflowId, diff, revision, allowlistedPaths: ['tests/membership.test.ts'], patchIntent: plan.intent, design: design.value, readinessPackage: investigated.readinessPackage, frameworkConventions: profile.frameworkConventions });
  const verification = await service.routeVerification({ workflowId, traceId, revision, review: automationReview.value, executorInput: { command: ['npm', 'test', '--', 'tests/membership.test.ts'] }, requirement: ['AC-1'], sources: [investigated.readinessPackage.packageId], ui: ['local fixture'], coverage: ['SCENARIO-001'], patch: ['patch'], approval: ['local mock approval'], blockers: [], limitations: ['mock providers; no live Jira or GitHub access'] });
  const state = await workflows.get(workflow.id);
  if (!state) throw new Error('Mock workflow disappeared during bootstrap.');
  await workflows.save({ ...state, stage: 'verification', status: 'completed', artifactIds: [...state.artifactIds, verification.artifact.id], updatedAt: asOf }, state.version);
  return { workflowId, traceId, revision, status: 'completed' as const, version: state.version + 1 };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const index = process.argv.indexOf('--root');
  const root = index >= 0 ? process.argv[index + 1] ?? '.qa-workflows' : '.qa-workflows';
  bootstrapEditorMock(root).then((result) => console.log(JSON.stringify(result, null, 2))).catch((error: unknown) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
}
