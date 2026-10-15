import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ZodError } from 'zod';
import {
  NonSdetAssignmentError,
  StoryAssignmentSchema,
  StoryAssignmentReplayMismatchError,
  StoryIntakeRouter,
  StoryNotAllowlistedError,
  UnsupportedStoryProviderError,
  type StoryAssignment,
  type StoryIntakeResult,
} from './story-intake.js';

const DEFAULT_ROUTE = '/story-assignments';
const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

export type StoryIntakeService = Pick<StoryIntakeRouter, 'intake'>;

export interface LocalAssignmentWebhookOptions {
  readonly service: StoryIntakeService;
  readonly route?: string;
  readonly maxBodyBytes?: number;
  readonly host?: string;
  readonly port?: number;
}

export interface RunningLocalAssignmentWebhook {
  readonly server: Server;
  readonly host: string;
  readonly port: number;
}

class InvalidJsonError extends Error {}
class RequestTooLargeError extends Error {}

function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host);
}

function routeFor(options: LocalAssignmentWebhookOptions): string {
  const route = options.route ?? DEFAULT_ROUTE;
  if (!route.startsWith('/') || route.length === 1 || route.endsWith('/')) {
    throw new Error('Local assignment webhook route must be a non-root path without a trailing slash.');
  }
  return route;
}

function writeJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(JSON.stringify(body));
}

async function readJson(request: IncomingMessage, maxBodyBytes: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > maxBodyBytes) throw new RequestTooLargeError();
    chunks.push(buffer);
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new InvalidJsonError();
  }
}

function errorResponse(error: unknown): { status: number; body: Record<string, unknown> } {
  if (error instanceof InvalidJsonError) return { status: 400, body: { error: 'Request body must be valid JSON.' } };
  if (error instanceof RequestTooLargeError) return { status: 413, body: { error: 'Request body is too large.' } };
  if (error instanceof ZodError) {
    return { status: 400, body: { error: 'Request is not a valid story assignment.', issues: error.issues } };
  }
  if (error instanceof StoryNotAllowlistedError) return { status: 403, body: { error: error.message } };
  if (error instanceof NonSdetAssignmentError || error instanceof UnsupportedStoryProviderError) {
    return { status: 422, body: { error: error.message } };
  }
  if (error instanceof StoryAssignmentReplayMismatchError) return { status: 409, body: { error: error.message } };
  return { status: 500, body: { error: 'Story intake failed.' } };
}

export function createLocalAssignmentWebhook(options: LocalAssignmentWebhookOptions): Server {
  const route = routeFor(options);
  const host = options.host ?? '127.0.0.1';
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  if (!isLoopbackHost(host)) throw new Error('Local assignment webhook only permits loopback hosts.');
  if (!Number.isInteger(maxBodyBytes) || maxBodyBytes < 1) {
    throw new Error('Local assignment webhook maxBodyBytes must be a positive integer.');
  }

  return createServer(async (request, response) => {
    if (request.url !== route) {
      writeJson(response, 404, { error: 'Not found.' });
      return;
    }
    if (request.method !== 'POST') {
      response.setHeader('allow', 'POST');
      writeJson(response, 405, { error: 'Only POST is supported.' });
      return;
    }
    if (!(request.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
      writeJson(response, 415, { error: 'Content-Type must be application/json.' });
      return;
    }

    try {
      const assignment = StoryAssignmentSchema.parse(await readJson(request, maxBodyBytes));
      const result: StoryIntakeResult = await options.service.intake(assignment as StoryAssignment);
      writeJson(response, 200, result);
    } catch (error) {
      const failure = errorResponse(error);
      writeJson(response, failure.status, failure.body);
    }
  });
}

export async function startLocalAssignmentWebhook(
  options: LocalAssignmentWebhookOptions,
): Promise<RunningLocalAssignmentWebhook> {
  const host = options.host ?? '127.0.0.1';
  const server = createLocalAssignmentWebhook(options);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, host, resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    server.close();
    throw new Error('Local assignment webhook did not receive a TCP address.');
  }
  return { server, host, port: (address as AddressInfo).port };
}
