import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createEditorServer } from '../src/editor-mcp.js';
import { seedEditorMock } from '../src/editor-mock.js';
import { FileArtifactStore, FileWorkflowStore } from '../src/filesystem-stores.js';
import { LifecycleCoordinator } from '../src/lifecycle-coordinator.js';

const roots: string[] = [];
const clients: Client[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map(client => client.close()));
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'qa-editor-'));
  roots.push(root);
  const mock = await seedEditorMock(root);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createEditorServer(root);
  const client = new Client({ name: 'editor-contract-test', version: '1.0' });
  clients.push(client);
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { root, mock, client };
}
function data(result: Awaited<ReturnType<Client['callTool']>>) {
  const content = result.content as Array<{ type: string; text?: string }>;
  return JSON.parse(content[0]!.text!) as Record<string, any>;
}

describe('editor MCP', () => {
  it('exposes bounded investigation, design planning, and attached handoff inspection', async () => {
    const root = await mkdtemp(join(tmpdir(), 'qa-editor-orchestration-'));
    roots.push(root);
    const workflows = new FileWorkflowStore(root);
    const artifacts = new FileArtifactStore(root);
    const traceId = '3d594650-3436-4d7c-86a7-2b94788009bc';
    const workflow = await new LifecycleCoordinator(workflows).start({ id: 'STORY-QE-42', traceId, approvalRequired: false });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createEditorServer(root);
    const client = new Client({ name: 'editor-orchestration-test', version: '1.0' });
    clients.push(client);
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const evidence = (id: string, source: 'jira' | 'github' | 'test', content: string) => ({
      id,
      source,
      uri: `local://${id}`,
      revision: 'rev-7',
      retrievedAt: '2026-10-15T12:00:00.000Z',
      content,
      estimatedTokens: Math.max(1, Math.ceil(content.length / 4)),
      relevance: 1,
    });
    const investigation = await client.callTool({ name: 'investigate_requirements', arguments: {
      workflowId: workflow.id,
      traceId,
      storyKey: 'QE-42',
      sourceRevision: 'rev-7',
      asOf: '2026-10-15T12:00:00.000Z',
      evidence: {
        ticket: [evidence('jira-QE-42', 'jira', JSON.stringify({ summary: 'Reject inactive members', acceptanceCriteria: ['Inactive members are rejected.'], component: 'membership' }))],
        history: [],
        source: [evidence('github-membership', 'github', JSON.stringify({ component: 'membership', revision: 'rev-7', files: ['src/membership.ts'] }))],
        tests: [evidence('test-membership', 'test', JSON.stringify({ covers: ['Inactive members are rejected.'] }))],
      },
    }});
    expect(investigation.isError).not.toBe(true);
    const investigated = data(investigation);
    expect(investigated.status).toBe('ready');
    expect(investigated.artifacts).toHaveLength(3);
    expect(investigated.artifacts.map((record: { id: string }) => record.id)).toContain('discrepancy:QE-42:rev-7');

    const readinessArtifactId = investigated.artifacts.find((record: { metadata: { artifactRole?: string } }) => record.metadata.artifactRole === 'readiness-package').id;
    const design = await client.callTool({ name: 'design_tests', arguments: {
      workflowId: workflow.id,
      readinessArtifactId,
      projectProfile: { frameworkConventions: { testRunner: 'vitest' }, testConventions: ['Given When Then'] },
    }});
    expect(design.isError).not.toBe(true);
    expect(data(design).value).toMatchObject({ artifactKind: 'test-design', decision: 'ready' });

    const handoffs = await client.callTool({ name: 'inspect_handoff_artifacts', arguments: { workflowId: workflow.id } });
    expect(handoffs.isError).not.toBe(true);
    expect(data(handoffs).artifacts.map((record: { id: string }) => record.id)).toEqual([
      'readiness-package:readiness:QE-42:rev-7',
      'discrepancy:QE-42:rev-7',
      'rtm:QE-42:rev-7',
      'test-design:QE-42:rev-7',
    ]);

    const tools = (await client.listTools()).tools;
    for (const name of ['investigate_requirements', 'design_tests', 'inspect_handoff_artifacts']) {
      expect(tools.find(tool => tool.name === name)?.annotations?.readOnlyHint).toBe(true);
    }
    expect(tools.some(tool => /shell|filesystem|provider|execute|approve/i.test(tool.name))).toBe(false);
  });

  it('cannot bypass Phase A through the MCP transition path or cross-trace artifacts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'qa-editor-gates-'));
    roots.push(root);
    const workflows = new FileWorkflowStore(root);
    const artifacts = new FileArtifactStore(root);
    const traceId = 'b364b03e-88b0-4a8e-a9ea-99b5ea8077cf';
    await new LifecycleCoordinator(workflows).start({ id: 'STORY-42', traceId });
    await artifacts.put({ id: 'other-trace', traceId: '3d594650-3436-4d7c-86a7-2b94788009bc', kind: 'approval',
      schemaVersion: '1.0', createdAt: '2026-09-30T00:00:00.000Z', content: {}, metadata: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createEditorServer(root);
    const client = new Client({ name: 'editor-gate-test', version: '1.0' });
    clients.push(client);
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const bypass = await client.callTool({ name: 'transition_workflow', arguments: {
      workflowId: 'STORY-42', to: 'planning', artifactIds: [],
    } });
    expect(bypass.isError).toBe(true);
    expect(data(bypass).error).toMatch(/Phase A gate/);
    const crossTrace = await client.callTool({ name: 'transition_workflow', arguments: {
      workflowId: 'STORY-42', to: 'planning', artifactIds: ['other-trace'],
    } });
    expect(crossTrace.isError).toBe(true);
    expect(data(crossTrace).error).toMatch(/another trace/);
  });

  it('starts through the same stdio command configured in VS Code', async () => {
    const root = await mkdtemp(join(tmpdir(), 'qa-editor-stdio-'));
    roots.push(root);
    await seedEditorMock(root);
    const client = new Client({ name: 'vscode-launch-test', version: '1.0' });
    clients.push(client);
    await client.connect(new StdioClientTransport({ command: process.execPath,
      args: [join(process.cwd(), 'node_modules/tsx/dist/cli.mjs'),
        join(process.cwd(), 'src/editor-mcp-server.ts'), '--root', root] }));
    const result = data(await client.callTool({ name: 'list_workflows', arguments: {} }));
    expect(result.workflows[0]).toMatchObject({ id: 'mock/QE-42', status: 'waiting-for-human' });
  });

  it('lets an editor inspect, answer and resume a persisted mock pause through MCP', async () => {
    const { client, mock, root } = await setup();
    expect((await client.listTools()).tools.map(t => t.name)).toContain('record_decision');
    const workflows = data(await client.callTool({ name: 'list_workflows', arguments: {} }));
    expect(workflows.workflows).toHaveLength(1);
    const pending = data(await client.callTool({ name: 'list_decisions', arguments: { workflowId: mock.workflowId } }));
    expect(pending.decisions).toHaveLength(1);
    const input = { workflowId: mock.workflowId, requestId: mock.requestId, expectedVersion: mock.version,
      responder: 'Mock SDET', answers: [{ questionId: 'Q-1', answer: 'Reject inactive requests as documented.', confirmedBy: 'Mock Dev', evidenceIds: [mock.evidenceId] }] };
    const denied = await client.callTool({ name: 'record_decision', arguments: input });
    expect(denied.isError).toBe(true);
    const recorded = data(await client.callTool({ name: 'record_decision', arguments: { ...input, confirmed: true } }));
    const resumed = data(await client.callTool({ name: 'resume_workflow', arguments: {
      workflowId: mock.workflowId, responseId: recorded.response.id, expectedVersion: mock.version + 1,
    } }));
    expect(resumed.workflow).toMatchObject({ status: 'pending', stage: 'refinement', approval: { status: 'pending' } });
    expect(resumed.nextAction).toBe('revalidate-current-stage');
    expect(await seedEditorMock(root)).toMatchObject({ workflowId: mock.workflowId });
  });

  it('rejects unrelated evidence and arbitrary paths and exposes no approval or execution tools', async () => {
    const { client, mock } = await setup();
    const tools = (await client.listTools()).tools;
    expect(tools.some(t => /approve|execute|shell/.test(t.name))).toBe(false);
    expect(tools.find(t => t.name === 'record_decision')?.annotations?.readOnlyHint).toBe(false);
    const unrelated = await client.callTool({ name: 'get_evidence', arguments: { workflowId: mock.workflowId, artifactId: '../secrets' } });
    expect(unrelated.isError).toBe(true);
    const extra = await client.callTool({ name: 'get_workflow', arguments: { workflowId: mock.workflowId, root: '../other-root' } });
    expect(extra.isError).toBe(true);
  });
});
