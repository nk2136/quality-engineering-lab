import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { GitHubRepositoryKnowledgeSource } from '../src/github-repository.js';
import { createEditorServer } from '../src/editor-mcp.js';
import { seedEditorMock, bootstrapEditorMock } from '../src/editor-mock.js';
import { JiraCloudKnowledgeSource } from '../src/jira-cloud.js';
import type { KnowledgeQuery } from '../src/contracts.js';
import { FileArtifactStore, FileWorkflowStore } from '../src/filesystem-stores.js';
import { LifecycleCoordinator } from '../src/lifecycle-coordinator.js';
import { HumanDecisionService } from '../src/human-decisions.js';

const revision = 'a'.repeat(40);
const traceId = 'b364b03e-88b0-4a8e-a9ea-99b5ea8077cf';
const roots: string[] = [];
const clients: Client[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function data(result: Awaited<ReturnType<Client['callTool']>>) {
  const content = result.content as Array<{ type: string; text?: string }>;
  return JSON.parse(content[0]!.text!) as Record<string, any>;
}

describe('merged workflow security and evaluation contracts', () => {
  it('redacts runtime authorization from provider error messages', async () => {
    const secret = 'Bearer security-evaluation-secret';
    const jira = new JiraCloudKnowledgeSource({
      baseUrl: 'https://example.atlassian.net',
      allowedIssueKeys: ['QE-42'],
      authorization: async () => secret,
      httpClient: async () => ({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
        json: async () => ({ errorMessages: [`Provider rejected ${secret}`] }),
      }),
    });
    const github = new GitHubRepositoryKnowledgeSource({
      repository: 'acme/product',
      revision,
      paths: ['README.md'],
      authorization: async () => secret,
      httpClient: async () => ({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
        json: async () => ({ message: `Provider rejected ${secret}` }),
      }),
    });

    const query: KnowledgeQuery = {
      traceId: '3d594650-3436-4d7c-86a7-2b94788009bc',
      text: 'QE-42',
      sources: ['jira'],
      maxResults: 10,
      asOf: '2026-10-15T12:00:00.000Z',
    };
    const jiraFailure = await jira.search(query).catch((error: unknown) => error);
    const githubFailure = await github.search({ ...query, text: 'readme', sources: ['github'] })
      .catch((error: unknown) => error);
    expect(jiraFailure).toMatchObject({ status: 401 });
    expect(githubFailure).toMatchObject({ status: 401 });
    expect(jiraFailure).toBeInstanceOf(Error);
    expect(githubFailure).toBeInstanceOf(Error);
    expect((jiraFailure as Error).message).not.toContain(secret);
    expect((githubFailure as Error).message).not.toContain(secret);
  });

  it('checks the Jira allowlist before credentials and network I/O', async () => {
    let credentialCalls = 0;
    let requestCalls = 0;
    const source = new JiraCloudKnowledgeSource({
      baseUrl: 'https://example.atlassian.net',
      allowedIssueKeys: ['QE-42'],
      authorization: async () => {
        credentialCalls += 1;
        return 'Bearer never-used';
      },
      httpClient: async () => {
        requestCalls += 1;
        throw new Error('HTTP must not run for a denied issue.');
      },
    });

    await expect(source.search({
      traceId: '3d594650-3436-4d7c-86a7-2b94788009bc',
      text: 'QE-43',
      sources: ['jira'],
      maxResults: 10,
      asOf: '2026-10-15T12:00:00.000Z',
    })).rejects.toThrow("Jira issue 'QE-43' is not in the configured allowlist.");
    expect(credentialCalls).toBe(0);
    expect(requestCalls).toBe(0);
  });

  it('rejects a human response after the workflow revision changes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'qa-security-stale-'));
    roots.push(root);
    const workflows = new FileWorkflowStore(root);
    const artifacts = new FileArtifactStore(root);
    await new LifecycleCoordinator(workflows).start({ id: 'mock/QE-42', traceId });
    await artifacts.put({
      id: 'story-evidence', traceId, kind: 'requirement-analysis', schemaVersion: '1.0',
      createdAt: '2026-10-15T12:00:00.000Z', content: { storyKey: 'QE-42' }, metadata: {},
    });
    const initial = (await workflows.get('mock/QE-42'))!;
    const attached = await workflows.save({ ...initial, artifactIds: ['story-evidence'] }, initial.version);
    const decisions = new HumanDecisionService(workflows, artifacts);
    const request = await decisions.pause({
      workflowId: attached.id, expectedVersion: attached.version, reason: 'clarification',
      questions: [{ id: 'Q-1', acIds: ['AC-1'], owner: 'product', question: 'Confirm behavior.', evidenceIds: ['story-evidence'] }],
    });
    const response = await decisions.respond({
      workflowId: attached.id, requestId: request.id, expectedVersion: attached.version + 1,
      responder: 'Mock SDET', answers: [{ questionId: 'Q-1', answer: 'Confirmed.', confirmedBy: 'product', evidenceIds: ['story-evidence'] }],
    });
    const changed = (await workflows.get(attached.id))!;
    await workflows.save({ ...changed, updatedAt: '2026-10-15T12:01:00.000Z' }, changed.version);

    await expect(decisions.resume({
      workflowId: attached.id, responseId: response.id, expectedVersion: changed.version + 1,
    })).rejects.toThrow('stale');
  });

  it('keeps local MCP reads confined to the startup root and workflow trace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'qa-security-mcp-'));
    roots.push(root);
    const mock = await seedEditorMock(root);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createEditorServer(root);
    const client = new Client({ name: 'security-contract-test', version: '1.0' });
    clients.push(client);
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const traversal = await client.callTool({ name: 'get_evidence', arguments: {
      workflowId: mock.workflowId, artifactId: '../outside-root',
    }});
    expect(traversal.isError).toBe(true);

    const injectedRoot = await client.callTool({ name: 'get_workflow', arguments: {
      workflowId: mock.workflowId, root: '../outside-root',
    }});
    expect(injectedRoot.isError).toBe(true);
    const injectedContent = injectedRoot.content as Array<{ type: string; text?: string }>;
    expect(injectedContent[0]).toMatchObject({ type: 'text' });
    expect(injectedContent[0]!.text).toMatch(/MCP error|root/i);
  });

  it('rejects cross-trace artifacts through the MCP evidence boundary', async () => {
    const root = await mkdtemp(join(tmpdir(), 'qa-security-trace-'));
    roots.push(root);
    const mock = await seedEditorMock(root);
    const { FileArtifactStore } = await import('../src/filesystem-stores.js');
    const artifacts = new FileArtifactStore(root);
    await artifacts.put({
      id: 'foreign-artifact', traceId: '3d594650-3436-4d7c-86a7-2b94788009bc',
      kind: 'requirement-analysis', schemaVersion: '1.0', createdAt: '2026-10-15T12:00:00.000Z',
      content: { secret: 'foreign data' }, metadata: {},
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createEditorServer(root);
    const client = new Client({ name: 'trace-boundary-test', version: '1.0' });
    clients.push(client);
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const result = await client.callTool({ name: 'get_evidence', arguments: {
      workflowId: mock.workflowId, artifactId: 'foreign-artifact',
    }});
    expect(result.isError).toBe(true);
    expect(data(result).error).toBe('Artifact is not linked to this workflow.');
    expect(JSON.stringify(result)).not.toContain('foreign data');
  });

  it('accepts the deterministic local mock workflow without live credentials or network', async () => {
    const root = await mkdtemp(join(tmpdir(), 'qa-security-mock-'));
    roots.push(root);
    const first = await bootstrapEditorMock(root);
    const second = await bootstrapEditorMock(root);

    expect(second).toEqual(first);
    expect(first).toMatchObject({ workflowId: 'mock/QE-42', traceId, revision: 'mock-r1', status: 'completed' });
    const { FileArtifactStore, FileWorkflowStore } = await import('../src/filesystem-stores.js');
    const workflow = await new FileWorkflowStore(root).get(first.workflowId);
    const artifacts = await new FileArtifactStore(root).listByTrace(first.traceId);
    expect(workflow).toMatchObject({ status: 'completed', stage: 'verification' });
    expect(artifacts).toHaveLength(8);
    expect(JSON.stringify({ workflow, artifacts })).not.toMatch(/Bearer |Basic |password|token/i);
  });
});
