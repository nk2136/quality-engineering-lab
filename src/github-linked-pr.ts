import { z } from 'zod';
import { ContextEvidenceSchema, type ContextEvidence } from './context.js';
import { KnowledgeQuerySchema, type KnowledgeQuery, type KnowledgeSource } from './contracts.js';

const GitObjectIdSchema = z.string().regex(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/);
const RepositorySchema = z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
const PullRequestSchema = z.object({
  number: z.number().int().positive(),
  id: z.number().int().positive(),
  html_url: z.string().url(),
  title: z.string(),
  body: z.string().nullable().optional(),
  state: z.enum(['open', 'closed']),
  draft: z.boolean().nullable().optional(),
  merged: z.boolean().default(false),
  merged_at: z.string().nullable().optional(),
  updated_at: z.string().min(1),
  head: z.object({ ref: z.string().min(1), sha: GitObjectIdSchema }),
  base: z.object({ ref: z.string().min(1), sha: GitObjectIdSchema }),
  user: z.object({ login: z.string().min(1) }).nullable().optional(),
  labels: z.array(z.object({ name: z.string().min(1) })).default([]),
}).passthrough();

export interface GitHubPullRequestHttpResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly statusText: string;
  json(): Promise<unknown>;
}

export interface GitHubPullRequestHttpRequest {
  method: 'GET';
  headers: Readonly<Record<string, string>>;
  redirect: 'error';
  signal: AbortSignal;
}

export type GitHubPullRequestHttpClient = (
  url: string,
  request: GitHubPullRequestHttpRequest,
) => Promise<GitHubPullRequestHttpResponse>;

export interface GitHubLinkedPrKnowledgeSourceOptions {
  repository: string;
  allowedPrNumbers: readonly number[];
  authorization?: () => Promise<string | undefined>;
  httpClient?: GitHubPullRequestHttpClient;
  timeoutMs?: number;
}

export class GitHubPullRequestApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'GitHubPullRequestApiError';
  }
}

function defaultHttpClient(url: string, request: GitHubPullRequestHttpRequest): Promise<GitHubPullRequestHttpResponse> {
  return fetch(url, request);
}

function redactSecret(value: string, secret: string | undefined): string {
  return secret === undefined || secret === '' ? value : value.split(secret).join('[REDACTED]');
}

async function errorMessage(response: GitHubPullRequestHttpResponse, authorization?: string): Promise<string> {
  try {
    const parsed = z.object({ message: z.string().min(1) }).safeParse(await response.json());
    if (parsed.success) return redactSecret(parsed.data.message, authorization).slice(0, 500);
  } catch {
    // Keep a status-based message when the provider does not return JSON.
  }
  return redactSecret(response.statusText || 'GitHub pull request request failed', authorization).slice(0, 500);
}

function parsePrNumber(value: string): number {
  const match = /^#?([1-9]\d*)$/.exec(value.trim());
  if (match === null) throw new Error('GitHub pull request query must be a positive PR number.');
  return z.number().int().positive().max(2_000_000_000).parse(Number(match[1]));
}

/** Reads immutable metadata for explicitly allowlisted GitHub pull requests. */
export class GitHubLinkedPrKnowledgeSource implements KnowledgeSource {
  readonly #repository: string;
  readonly #allowedPrNumbers: ReadonlySet<number>;
  readonly #authorization: () => Promise<string | undefined>;
  readonly #httpClient: GitHubPullRequestHttpClient;
  readonly #timeoutMs: number;

  constructor(options: GitHubLinkedPrKnowledgeSourceOptions) {
    this.#repository = RepositorySchema.parse(options.repository);
    const numbers = z.array(z.number().int().positive().max(2_000_000_000)).min(1).max(100).parse([...options.allowedPrNumbers]);
    if (new Set(numbers).size !== numbers.length) throw new Error('GitHub PR allowlist must not contain duplicate numbers.');
    this.#allowedPrNumbers = new Set(numbers);
    this.#authorization = options.authorization ?? (() => Promise.resolve(undefined));
    this.#httpClient = options.httpClient ?? defaultHttpClient;
    this.#timeoutMs = z.number().int().positive().max(60_000).parse(options.timeoutMs ?? 10_000);
  }

  async search(queryValue: KnowledgeQuery): Promise<readonly ContextEvidence[]> {
    const query = KnowledgeQuerySchema.parse(queryValue);
    if (!query.sources.includes('github')) return [];
    const number = parsePrNumber(query.text);
    if (!this.#allowedPrNumbers.has(number)) throw new Error(`GitHub pull request '${number}' is not in configured allowlist.`);

    const authorization = await this.#authorization();
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2026-03-10',
      'User-Agent': 'quality-engineering-lab',
    };
    if (authorization !== undefined && authorization.trim() !== '') headers.Authorization = authorization;
    const url = `https://api.github.com/repos/${this.#repository}/pulls/${number}`;
    const response = await this.#httpClient(url, {
      method: 'GET', headers, redirect: 'error', signal: AbortSignal.timeout(this.#timeoutMs),
    });
    if (!response.ok) throw new GitHubPullRequestApiError(response.status, await errorMessage(response, authorization));
    const pullRequest = PullRequestSchema.parse(await response.json());
    if (pullRequest.number !== number) throw new Error(`GitHub returned pull request '${pullRequest.number}' for requested '${number}'.`);
    const revision = pullRequest.head.sha;
    const content = JSON.stringify({
      number: pullRequest.number,
      id: pullRequest.id,
      title: pullRequest.title,
      body: pullRequest.body ?? null,
      state: pullRequest.state,
      draft: pullRequest.draft ?? null,
      merged: pullRequest.merged,
      mergedAt: pullRequest.merged_at ?? null,
      updatedAt: pullRequest.updated_at,
      author: pullRequest.user?.login ?? null,
      labels: pullRequest.labels.map((label) => label.name),
      head: { ref: pullRequest.head.ref, sha: pullRequest.head.sha },
      base: { ref: pullRequest.base.ref, sha: pullRequest.base.sha },
    }, null, 2);
    return [ContextEvidenceSchema.parse({
      id: `github-pr:${this.#repository}:${number}:${revision}`,
      source: 'github',
      uri: `https://github.com/${this.#repository}/pull/${number}`,
      revision,
      retrievedAt: query.asOf,
      content,
      estimatedTokens: Math.max(1, Math.ceil(content.length / 4)),
      relevance: 1,
    })];
  }
}

export { GitHubLinkedPrKnowledgeSource as GitHubPullRequestKnowledgeSource };
