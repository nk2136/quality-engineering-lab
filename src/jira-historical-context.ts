import { z } from 'zod';
import { ContextEvidenceSchema, type ContextEvidence } from './context.js';
import { adfToText } from './jira-cloud.js';
import { KnowledgeQuerySchema, type KnowledgeQuery, type KnowledgeSource } from './contracts.js';

const JiraIssueKeySchema = z.string().regex(/^[A-Z][A-Z0-9_]*-\d+$/);
const JiraCommentSchema = z.object({
  id: z.union([z.string(), z.number().int()]).transform(String),
  author: z.object({ displayName: z.string().optional(), accountId: z.string().optional() }).passthrough().optional(),
  created: z.string().min(1),
  updated: z.string().optional(),
  body: z.unknown().optional(),
}).passthrough();
const JiraCommentPageSchema = z.object({
  startAt: z.number().int().nonnegative().default(0),
  maxResults: z.number().int().positive().default(0),
  total: z.number().int().nonnegative().default(0),
  comments: z.array(JiraCommentSchema).default([]),
}).passthrough();
const JiraHistoryItemSchema = z.object({
  field: z.string().min(1),
  fromString: z.string().nullable().optional(),
  toString: z.string().nullable().optional(),
}).passthrough();
const JiraHistorySchema = z.object({
  id: z.union([z.string(), z.number().int()]).transform(String),
  created: z.string().min(1),
  author: z.object({ displayName: z.string().optional(), accountId: z.string().optional() }).passthrough().optional(),
  items: z.array(JiraHistoryItemSchema).default([]),
}).passthrough();
const JiraHistoryPageSchema = z.object({
  startAt: z.number().int().nonnegative().default(0),
  maxResults: z.number().int().positive().default(0),
  total: z.number().int().nonnegative().default(0),
  values: z.array(JiraHistorySchema).default([]),
}).passthrough();

export interface JiraHistoricalHttpResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly statusText: string;
  json(): Promise<unknown>;
}

export interface JiraHistoricalHttpRequest {
  method: 'GET';
  headers: Readonly<Record<string, string>>;
  redirect: 'error';
  signal: AbortSignal;
}

export type JiraHistoricalHttpClient = (
  url: string,
  request: JiraHistoricalHttpRequest,
) => Promise<JiraHistoricalHttpResponse>;

export interface JiraHistoricalContextKnowledgeSourceOptions {
  baseUrl: string;
  allowedIssueKeys: readonly string[];
  authorization?: () => Promise<string | undefined>;
  httpClient?: JiraHistoricalHttpClient;
  timeoutMs?: number;
  maxComments?: number;
  maxChangelogEntries?: number;
}

export class JiraHistoricalApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'JiraHistoricalApiError';
  }
}

function normalizeBaseUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:') throw new Error('Jira historical baseUrl must use HTTPS.');
  if (url.username !== '' || url.password !== '') throw new Error('Jira historical baseUrl must not contain credentials.');
  url.pathname = url.pathname.replace(/\/+$/, '');
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

function defaultHttpClient(url: string, request: JiraHistoricalHttpRequest): Promise<JiraHistoricalHttpResponse> {
  return fetch(url, request);
}

function redactSecret(value: string, secret: string | undefined): string {
  return secret === undefined || secret === '' ? value : value.split(secret).join('[REDACTED]');
}

async function errorMessage(response: JiraHistoricalHttpResponse, authorization?: string): Promise<string> {
  try {
    const body = await response.json();
    const parsed = z.object({
      errorMessages: z.array(z.string()).optional(),
      errors: z.record(z.string(), z.string()).optional(),
    }).safeParse(body);
    if (parsed.success) {
      const details = [
        ...(parsed.data.errorMessages ?? []),
        ...Object.values(parsed.data.errors ?? {}),
      ].join('; ');
      if (details !== '') return redactSecret(details, authorization).slice(0, 500);
    }
  } catch {
    // Keep a status-based message when the provider does not return JSON.
  }
  return redactSecret(response.statusText || 'Jira historical request failed', authorization).slice(0, 500);
}

function authorName(author: { displayName?: string | undefined; accountId?: string | undefined } | undefined): string | null {
  return author?.displayName ?? author?.accountId ?? null;
}

function latestRevision(comments: readonly z.infer<typeof JiraCommentSchema>[], histories: readonly z.infer<typeof JiraHistorySchema>[], fallback: string): string {
  return [...comments.map((item) => item.updated ?? item.created), ...histories.map((item) => item.created)]
    .sort()
    .at(-1) ?? fallback;
}

/** Reads only bounded comment and changelog pages for allowlisted Jira issues. */
export class JiraHistoricalContextKnowledgeSource implements KnowledgeSource {
  readonly #baseUrl: string;
  readonly #allowedIssueKeys: ReadonlySet<string>;
  readonly #authorization: () => Promise<string | undefined>;
  readonly #httpClient: JiraHistoricalHttpClient;
  readonly #timeoutMs: number;
  readonly #maxComments: number;
  readonly #maxChangelogEntries: number;

  constructor(options: JiraHistoricalContextKnowledgeSourceOptions) {
    this.#baseUrl = normalizeBaseUrl(options.baseUrl);
    const keys = z.array(JiraIssueKeySchema).min(1).parse([...options.allowedIssueKeys]);
    if (new Set(keys).size !== keys.length) throw new Error('Jira issue allowlist must not contain duplicate keys.');
    this.#allowedIssueKeys = new Set(keys);
    this.#authorization = options.authorization ?? (() => Promise.resolve(undefined));
    this.#httpClient = options.httpClient ?? defaultHttpClient;
    this.#timeoutMs = z.number().int().positive().max(60_000).parse(options.timeoutMs ?? 10_000);
    this.#maxComments = z.number().int().positive().max(100).parse(options.maxComments ?? 50);
    this.#maxChangelogEntries = z.number().int().positive().max(100).parse(options.maxChangelogEntries ?? 50);
  }

  async search(queryValue: KnowledgeQuery): Promise<readonly ContextEvidence[]> {
    const query = KnowledgeQuerySchema.parse(queryValue);
    if (!query.sources.includes('jira')) return [];
    const issueKey = JiraIssueKeySchema.parse(query.text.trim());
    if (!this.#allowedIssueKeys.has(issueKey)) throw new Error(`Jira issue '${issueKey}' is not in configured allowlist.`);

    const authorization = await this.#authorization();
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (authorization !== undefined && authorization.trim() !== '') headers.Authorization = authorization;
    const request = async (path: string, limit: number): Promise<unknown> => {
      const url = `${this.#baseUrl}/rest/api/3/issue/${encodeURIComponent(issueKey)}/${path}?startAt=0&maxResults=${limit}`;
      const response = await this.#httpClient(url, {
        method: 'GET', headers, redirect: 'error', signal: AbortSignal.timeout(this.#timeoutMs),
      });
      if (!response.ok) throw new JiraHistoricalApiError(response.status, await errorMessage(response, authorization));
      return response.json();
    };

    const [commentsValue, changelogValue] = await Promise.all([
      request('comment', this.#maxComments),
      request('changelog', this.#maxChangelogEntries),
    ]);
    const commentsPage = JiraCommentPageSchema.parse(commentsValue);
    const historyPage = JiraHistoryPageSchema.parse(changelogValue);
    const comments = commentsPage.comments.slice(0, this.#maxComments).map((item) => ({
      id: item.id,
      author: authorName(item.author),
      created: item.created,
      updated: item.updated ?? null,
      body: adfToText(item.body),
    }));
    const changelog = historyPage.values.slice(0, this.#maxChangelogEntries).map((history) => ({
      id: history.id,
      author: authorName(history.author),
      created: history.created,
      items: history.items.map((item) => ({ field: item.field, from: item.fromString ?? null, to: item.toString ?? null })),
    }));
    const revision = latestRevision(commentsPage.comments.slice(0, this.#maxComments), historyPage.values.slice(0, this.#maxChangelogEntries), query.asOf);
    const content = JSON.stringify({
      issueKey,
      comments,
      changelog,
      commentPage: { startAt: commentsPage.startAt, total: commentsPage.total, maxResults: this.#maxComments },
      changelogPage: { startAt: historyPage.startAt, total: historyPage.total, maxResults: this.#maxChangelogEntries },
    }, null, 2);
    return [ContextEvidenceSchema.parse({
      id: `jira-history:${issueKey}:${revision}`,
      source: 'jira',
      uri: `${this.#baseUrl}/browse/${encodeURIComponent(issueKey)}`,
      revision,
      retrievedAt: query.asOf,
      content,
      estimatedTokens: Math.max(1, Math.ceil(content.length / 4)),
      relevance: 1,
    })];
  }
}

export { JiraHistoricalContextKnowledgeSource as JiraHistoricalKnowledgeSource };
