import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { InMemoryArtifactStore, InMemoryWorkflowStore } from '../src/in-memory-stores.js';
import { createLiveReadinessKnowledgeSource } from '../src/live-readiness-adapters.js';
import { staticEvidenceSource, StoryToTestWorkflowService } from '../src/workflow-services.js';

const traceId = '3d594650-3436-4d7c-86a7-2b94788009bc';
const revision = 'rev-7';
const asOf = '2026-10-15T12:00:00.000Z';

function evidence(id: string, source: 'jira' | 'github' | 'test', content: string, itemRevision = revision) {
  return {
    id,
    source,
    uri: `local://${id}`,
    revision: itemRevision,
    retrievedAt: asOf,
    content,
    estimatedTokens: Math.max(1, Math.ceil(content.length / 4)),
    relevance: 1,
  };
}

function profile() {
  return {
    frameworkConventions: { testRunner: 'vitest', testFilePatterns: ['tests/**/*.test.ts'], testDirectory: 'tests' },
    testConventions: ['BDD Given When Then'],
    interactionModel: 'framework-neutral',
    dataRules: { syntheticDataOnly: true, secretsAllowed: false, allowedDataSources: ['fixtures', 'mocks', 'local-artifacts'] },
  };
}

describe('StoryToTestWorkflowService', () => {
  it('integrates allowlisted live readiness sources without publishing runtime credentials', async () => {
    const artifacts = new InMemoryArtifactStore();
    const workflows = new InMemoryWorkflowStore();
    const runtimeCredential = 'Bearer runtime-only-secret';
    const requests: Array<{ url: string; authorization: string | undefined }> = [];
    const source = createLiveReadinessKnowledgeSource({
      jira: { baseUrl: 'https://example.atlassian.net', allowedIssueKeys: ['QE-42'] },
      github: { repository: 'acme/product', revision: 'a'.repeat(40), paths: ['src/membership.ts'] },
    }, {
      credentials: {
        jira: async () => runtimeCredential,
        github: async () => runtimeCredential,
      },
      jiraHttpClient: async (url, request) => {
        requests.push({ url, authorization: request.headers.Authorization });
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => ({
            id: '10042',
            key: 'QE-42',
            fields: {
              summary: 'Reject inactive members',
              description: 'AC-1: Inactive members receive rejection.',
              updated: '2026-10-15T11:00:00.000+0000',
              status: { name: 'Refinement' },
              issuetype: { name: 'Story' },
              components: [{ name: 'membership-service' }],
              issuelinks: [],
            },
          }),
        };
      },
      githubHttpClient: async (url, request) => {
        requests.push({ url, authorization: request.headers.Authorization });
        const content = JSON.stringify({
          storyKey: 'QE-42',
          component: 'membership-service',
          revision: 'a'.repeat(40),
          files: ['src/membership.ts'],
        });
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => ({
            type: 'file',
            encoding: 'base64',
            size: Buffer.byteLength(content),
            path: 'src/membership.ts',
            sha: 'a'.repeat(40),
            content: Buffer.from(content).toString('base64'),
          }),
        };
      },
    });
    const history = staticEvidenceSource({ evidence: [evidence('history-QE-42', 'jira', JSON.stringify({ summary: 'Prior behavior.' }))] });
    const tests = staticEvidenceSource({ evidence: [evidence('test-QE-42', 'test', JSON.stringify({ covers: ['Inactive members receive rejection.'] }))] });
    const service = new StoryToTestWorkflowService({
      artifacts,
      workflows,
      knowledgeSources: { ticket: source, history, source, tests },
      now: () => asOf,
    });

    const result = await service.investigateRequirements({
      traceId,
      storyKey: 'QE-42',
      sourceRevision: 'a'.repeat(40),
      asOf,
    });

    expect(requests).toHaveLength(2);
    expect(requests.every((request) => request.authorization === runtimeCredential)).toBe(true);
    expect(requests[0]?.url).toContain('/rest/api/3/issue/QE-42?');
    expect(requests[1]?.url).toBe(
      `https://api.github.com/repos/acme/product/contents/src/membership.ts?ref=${'a'.repeat(40)}`,
    );
    const agentFacingArtifacts = JSON.stringify({ result, artifacts: await artifacts.listByTrace(traceId) });
    expect(agentFacingArtifacts).not.toContain(runtimeCredential);
    expect(agentFacingArtifacts).not.toContain('runtime-only-secret');
    expect(agentFacingArtifacts).toContain('QE-42');
    expect(agentFacingArtifacts).toContain('src/membership.ts');
  });

  it('wires investigation, handoffs, design, review, bounded automation, and verification', async () => {
    const artifacts = new InMemoryArtifactStore();
    const workflows = new InMemoryWorkflowStore();
    const service = new StoryToTestWorkflowService({
      artifacts,
      workflows,
      requirements: {
        ticket: { search: async () => [evidence('jira-QE-42', 'jira', JSON.stringify({ key: 'QE-42', summary: 'Reject inactive members', acceptanceCriteria: ['Inactive members receive rejection.'], component: 'membership-service' }))] },
        history: { search: async () => [] },
        source: { search: async () => [evidence('github-membership', 'github', JSON.stringify({ component: 'membership-service', branch: 'main', revision, files: ['src/membership.ts'] }))] },
        tests: { search: async () => [evidence('test-membership', 'test', JSON.stringify({ path: 'tests/membership.test.ts', covers: ['Inactive members receive rejection.'] }))] },
      },
      now: () => asOf,
      execute: vi.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0, timedOut: false, triage: { category: 'success', evidence: '' } }),
    });

    const workflow = await service.coordinator.start({ id: 'story/QE-42', traceId, approvalRequired: false });
    const investigated = await service.investigateRequirements({ traceId, storyKey: 'QE-42', sourceRevision: revision, asOf, workflowId: workflow.id });
    expect(investigated.status).toBe('ready');
    expect(investigated.artifacts).toHaveLength(3);
    expect((await artifacts.listByTrace(traceId))).toHaveLength(3);

    const design = await service.designTests({ workflowId: workflow.id, readinessPackage: investigated.readinessPackage, projectProfile: profile() });
    expect(design.status).toBe('ready');
    expect(design.value).toMatchObject({ artifactKind: 'test-design', decision: 'ready' });

    const designReview = await service.reviewTestDesign({
      workflowId: workflow.id,
      readinessPackage: investigated.readinessPackage,
      design: design.artifact.content,
    });
    expect(designReview.value).toMatchObject({ verdict: 'approve', nextStage: 'implementation' });

    const inventory = [{ path: 'tests/membership.test.ts', revision, kind: 'test' }, { path: 'tests/fixtures/membership.ts', revision, kind: 'fixture' }];
    const plan = await service.planAutomation({ workflowId: workflow.id, design: design.value, readinessPackage: investigated.readinessPackage, projectProfile: profile(), repositoryInventory: inventory });
    expect(plan.value).toMatchObject({ decision: 'ready' });

    const diff = 'diff --git a/tests/membership.test.ts b/tests/membership.test.ts\n+++ b/tests/membership.test.ts\n@@ -1,1 +1,3 @@\n+import { test, expect } from "vitest";\n+test("rejects inactive members", () => expect(true).toBe(true));';
    const automationReview = await service.reviewAutomation({ workflowId: workflow.id, diff, revision, allowlistedPaths: ['tests/membership.test.ts'], patchIntent: plan.intent, design: design.value, readinessPackage: investigated.readinessPackage, frameworkConventions: profile().frameworkConventions });
    expect(automationReview.value).toMatchObject({ verdict: 'approve', revision });

    const verification = await service.routeVerification({
      workflowId: workflow.id,
      traceId,
      revision,
      review: automationReview.value,
      executorInput: { command: ['npm', 'test', '--', 'tests/membership.test.ts'] },
      requirement: ['AC-1'], sources: [investigated.readinessPackage.packageId], ui: ['local fixture'], coverage: ['SCENARIO-001'], patch: ['patch'], approval: ['human-review'], blockers: [], limitations: ['local synthetic fixture'],
    });
    expect(verification.status).toBe('completed');
    expect(verification.report).toMatchObject({ releaseAuthorized: false, state: 'completed' });
    expect(JSON.stringify(verification.report)).not.toContain('npm test');
    expect(createHash('sha256').update(diff).digest('hex')).toBe(automationReview.value.patchHash);
  });

  it('stops before design and never advances when investigation needs a human', async () => {
    const artifacts = new InMemoryArtifactStore();
    const workflows = new InMemoryWorkflowStore();
    const service = new StoryToTestWorkflowService({
      artifacts,
      workflows,
      requirements: {
        ticket: { search: async () => [evidence('jira-QE-43', 'jira', JSON.stringify({ key: 'QE-43', summary: 'Ambiguous story', acceptanceCriteria: ['Do something appropriate.'] }))] },
        history: { search: async () => [] }, source: { search: async () => [] }, tests: { search: async () => [] },
      },
      now: () => asOf,
    });
    const workflow = await service.coordinator.start({ id: 'story/QE-43', traceId, approvalRequired: false });
    const result = await service.investigateRequirements({ traceId, storyKey: 'QE-43', sourceRevision: revision, asOf, workflowId: workflow.id });
    expect(result.status).toBe('waiting-for-human');
    expect(result.questions.length).toBeGreaterThan(0);
    await expect(service.designTests({ workflowId: workflow.id, readinessPackage: result.readinessPackage, projectProfile: profile() })).rejects.toThrow(/ready-for-design|readiness/i);
    expect((await workflows.get(workflow.id))?.stage).toBe('refinement');
    expect((await workflows.get(workflow.id))?.status).toBe('pending');
  });
});
