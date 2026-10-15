import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createLocalAssignmentWebhook,
  startLocalAssignmentWebhook,
  type StoryIntakeService,
} from '../src/local-webhook.js';
import type { StoryAssignment } from '../src/story-intake.js';

const assignment: StoryAssignment = {
  assignmentId: 'assignment-QE-42',
  assignee: 'sdet-agent',
  traceId: '3d594650-3436-4d7c-86a7-2b94788009bc',
  provider: 'jira',
  issueKey: 'QE-42',
  sourceRevision: '2026-10-15T18:00:00.000+0000',
  workType: 'sdet',
};

const result = {
  assignmentId: assignment.assignmentId,
  storyKey: assignment.issueKey,
  provider: 'jira' as const,
  revision: assignment.sourceRevision,
  evidence: {},
  workflow: {},
};

const servers: ReturnType<typeof createLocalAssignmentWebhook>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

function service(): StoryIntakeService {
  return { intake: vi.fn(async () => result as never) };
}

async function request(path: string, init?: RequestInit): Promise<Response> {
  const server = await startLocalAssignmentWebhook({ service: service() });
  servers.push(server.server);
  return fetch(`http://127.0.0.1:${server.port}${path}`, init);
}

describe('local assignment webhook', () => {
  it('accepts a valid local assignment and passes it to StoryIntakeRouter', async () => {
    const intake = vi.fn(async () => result as never);
    const server = createLocalAssignmentWebhook({ service: { intake } });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;

    const response = await fetch(`http://127.0.0.1:${port}/story-assignments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(assignment),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(result);
    expect(intake).toHaveBeenCalledWith(assignment);
  });

  it('rejects malformed JSON before service invocation', async () => {
    const response = await request('/story-assignments', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{',
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Request body must be valid JSON.' });
  });

  it('rejects non-JSON, unsupported methods, and non-loopback binding', async () => {
    await expect(Promise.resolve().then(() => createLocalAssignmentWebhook({ service: service(), host: '0.0.0.0' })))
      .rejects.toThrow('only permits loopback hosts');

    const wrongType = await request('/story-assignments', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: JSON.stringify(assignment),
    });
    expect(wrongType.status).toBe(415);

    const wrongMethod = await request('/story-assignments', { method: 'GET' });
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.get('allow')).toBe('POST');
  });

  it('enforces the configured request size limit', async () => {
    const server = await startLocalAssignmentWebhook({ service: service(), maxBodyBytes: 8 });
    servers.push(server.server);

    const response = await fetch(`http://127.0.0.1:${server.port}/story-assignments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(assignment),
    });

    expect(response.status).toBe(413);
  });
});
