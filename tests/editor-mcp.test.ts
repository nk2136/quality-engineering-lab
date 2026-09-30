import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createEditorServer } from '../src/editor-mcp.js';
import { seedEditorMock } from '../src/editor-mock.js';

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
