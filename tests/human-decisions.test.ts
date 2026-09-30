import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileArtifactStore, FileWorkflowStore } from '../src/filesystem-stores.js';
import { LifecycleCoordinator } from '../src/lifecycle-coordinator.js';
import { HumanDecisionService } from '../src/human-decisions.js';

const traceId = 'b364b03e-88b0-4a8e-a9ea-99b5ea8077cf';
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'qa-decisions-'));
  roots.push(root);
  const workflows = new FileWorkflowStore(root);
  const artifacts = new FileArtifactStore(root);
  const coordinator = new LifecycleCoordinator(workflows);
  await coordinator.start({ id: 'mock/QE-42', traceId });
  await artifacts.put({ id: 'story-1', traceId, kind: 'requirement-analysis', schemaVersion: '1.0', createdAt: '2026-09-30T00:00:00.000Z', content: { storyKey: 'QE-42', revision: 'r1' }, metadata: {} });
  const state = (await workflows.get('mock/QE-42'))!;
  await workflows.save({ ...state, artifactIds: ['story-1'] }, state.version);
  const service = new HumanDecisionService(workflows, artifacts);
  const request = await service.pause({
    workflowId: state.id, expectedVersion: 1, reason: 'clarification',
    questions: [{ id: 'Q-1', acIds: ['AC-1'], owner: 'Dev', question: 'Confirm the expected denial response.', evidenceIds: ['story-1'] }],
  });
  return { root, workflows, artifacts, coordinator, service, request };
}

function response(requestId: string, expectedVersion = 2) {
  return { workflowId: 'mock/QE-42', requestId, expectedVersion, responder: 'Mock SDET',
    answers: [{ questionId: 'Q-1', answer: 'The request is rejected with the documented response.', confirmedBy: 'Dev', evidenceIds: ['story-1'] }] };
}

describe('human decisions', () => {
  it('persists the request and response across restart and resumes the same stage for revalidation', async () => {
    const { root, service, request, workflows } = await setup();
    expect(await service.listPending('mock/QE-42')).toHaveLength(1);
    const saved = await service.respond(response(request.id));
    expect(await workflows.get('mock/QE-42')).toMatchObject({ status: 'waiting-for-human', stage: 'refinement', version: 3, approval: { status: 'pending' } });
    const restarted = new HumanDecisionService(new FileWorkflowStore(root), new FileArtifactStore(root));
    expect(await restarted.listPending('mock/QE-42')).toEqual([]);
    const resumed = await restarted.resume({ workflowId: 'mock/QE-42', responseId: saved.id, expectedVersion: 3 });
    expect(resumed).toMatchObject({ status: 'pending', stage: 'refinement', version: 4, approval: { status: 'pending' } });
    expect(resumed.artifactIds).toContain(saved.id);
  });

  it('refuses to run or transition while the human decision is pending', async () => {
    const { coordinator } = await setup();
    await expect(coordinator.transition('mock/QE-42', 'planning')).rejects.toThrow('waiting-for-human');
    let calls = 0;
    await expect(coordinator.run('mock/QE-42', 'planning', async () => { calls += 1; return []; })).rejects.toThrow('waiting-for-human');
    expect(calls).toBe(0);
  });

  it('rejects stale responses and answers to unknown or missing questions', async () => {
    const { service, request } = await setup();
    await expect(service.respond(response(request.id, 1))).rejects.toThrow('version conflict');
    await expect(service.respond({ ...response(request.id), answers: [] })).rejects.toThrow();
    await expect(service.respond({ ...response(request.id), answers: [{ ...response(request.id).answers[0], questionId: 'Q-other' }] })).rejects.toThrow('every question exactly once');
  });

  it('rejects unrelated evidence and unconfirmed identities', async () => {
    const { service, request, artifacts } = await setup();
    await artifacts.put({ id: 'other-story', traceId: '3d594650-3436-4d7c-86a7-2b94788009bc', kind: 'requirement-analysis', schemaVersion: '1.0', createdAt: '2026-09-30T00:00:00.000Z', content: {}, metadata: {} });
    await expect(service.respond({ ...response(request.id), answers: [{ ...response(request.id).answers[0], evidenceIds: ['other-story'] }] })).rejects.toThrow('workflow evidence');
    await expect(service.respond({ ...response(request.id), responder: '' })).rejects.toThrow();
  });

  it('publishes only one response when two editor sessions answer concurrently', async () => {
    const { service, request, workflows } = await setup();
    const results = await Promise.allSettled([service.respond(response(request.id)), service.respond(response(request.id))]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    const state = (await workflows.get('mock/QE-42'))!;
    const accepted = await service.inspect('mock/QE-42', request.id);
    expect(accepted.response).toBeDefined();
    expect(state.artifactIds.filter(id => id === accepted.response!.id)).toHaveLength(1);
  });

  it('rejects an answer after cancellation and stale resume after input changes', async () => {
    const first = await setup();
    await first.coordinator.cancel('mock/QE-42');
    await expect(first.service.respond(response(first.request.id, 3))).rejects.toThrow('waiting-for-human');
    const second = await setup();
    const saved = await second.service.respond(response(second.request.id));
    const state = (await second.workflows.get('mock/QE-42'))!;
    await second.workflows.save({ ...state, updatedAt: new Date().toISOString() }, state.version);
    await expect(second.service.resume({ workflowId: 'mock/QE-42', responseId: saved.id, expectedVersion: 4 })).rejects.toThrow('stale');
  });

  it('rejects pausing with unowned or duplicated questions', async () => {
    const { service } = await setup();
    const question = { id: 'Q-1', acIds: ['AC-1'], owner: '', question: 'Question', evidenceIds: ['story-1'] };
    await expect(service.pause({ workflowId: 'mock/QE-42', expectedVersion: 2, reason: 'clarification', questions: [question] })).rejects.toThrow();
  });
});
