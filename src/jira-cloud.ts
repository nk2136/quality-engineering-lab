import { z } from 'zod';
import { ContextEvidenceSchema, type ContextEvidence } from './context.js';
import { KnowledgeQuerySchema, type KnowledgeQuery, type KnowledgeSource } from './contracts.js';

const JiraIssueKeySchema = z.string().regex(/^[A-Z][A-Z0-9_]*-\d+$/);

const NamedFieldSchema = z.object({ name: z.string().min(1) });
const LinkedIssueSchema = z.object({
  key: JiraIssueKeySchema,
  fields: z.object({ summary: z.string().min(1) }).passthrough(),
});

const JiraIssueSchema = z.object({
  id: z.string().min(1),
  key: JiraIssueKeySchema,
  fields: z.object({
    summary: z.string().min(1),
    description: z.unknown().nullable().optional(),
    updated: z.string().min(1),
    status: NamedFieldSchema,
    issuetype: NamedFieldSchema,
    priority: NamedFieldSchema.nullable().optional(),
    labels: z.array(z.string()).default([]),
    components: z.array(NamedFieldSchema).default([]),
    fixVersions: z.array(NamedFieldSchema).default([]),
    parent: LinkedIssueSchema.optional(),
    issuelinks: z.array(
      z.object({
        type: z.object({
          inward: z.string().min(1),
          outward: z.string().min(1),
        }),
        inwardIssue: LinkedIssueSchema.optional(),
        outwardIssue: LinkedIssueSchema.optional(),
      }),
    ).default([]),
  }),
});

export interface JiraHttpResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly statusText: string;
  json(): Promise<unknown>;
}

export interface JiraHttpRequest {
  method: 'GET';
  headers: Readonly<Record<string, string>>;
  redirect: 'error';
  signal: AbortSignal;
}

export type JiraHttpClient = (
  url: string,
  request: JiraHttpRequest,
) => Promise<JiraHttpResponse>;

export interface JiraCloudKnowledgeSourceOptions {
  baseUrl: string;
  authorization?: () => Promise<string | undefined>;
  httpClient?: JiraHttpClient;
  timeoutMs?: number;
}

export class JiraApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'JiraApiError';
  }
}

function normalizeBaseUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:') {
    throw new Error('Jira Cloud baseUrl must use HTTPS.');
  }
  if (url.username !== '' || url.password !== '') {
    throw new Error('Jira Cloud baseUrl must not contain credentials.');
  }
  url.pathname = url.pathname.replace(/\/+$/, '');
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

function defaultHttpClient(url: string, request: JiraHttpRequest): Promise<JiraHttpResponse> {
  return fetch(url, request);
}

function nodeText(value: unknown): string {
  if (typeof value !== 'object' || value === null) return '';
  const node = value as Record<string, unknown>;
  if (node.type === 'text' && typeof node.text === 'string') return node.text;
  if (node.type === 'hardBreak') return '\n';

  const attrs = typeof node.attrs === 'object' && node.attrs !== null
    ? node.attrs as Record<string, unknown>
    : {};
  if (node.type === 'mention' && typeof attrs.text === 'string') return attrs.text;
  if (node.type === 'emoji') {
    if (typeof attrs.text === 'string') return attrs.text;
    if (typeof attrs.shortName === 'string') return attrs.shortName;
  }
  if (node.type === 'inlineCard' && typeof attrs.url === 'string') return attrs.url;

  const children = Array.isArray(node.content) ? node.content.map(nodeText).join('') : '';
  return ['paragraph', 'heading', 'listItem', 'codeBlock'].includes(String(node.type))
    ? `${children}\n`
    : children;
}

export function adfToText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.trim();
  return nodeText(value).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

async function errorMessage(response: JiraHttpResponse): Promise<string> {
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
      ].join('; ').slice(0, 500);
      if (details !== '') return details;
    }
  } catch {
    // Preserve the status-based message when Jira does not return JSON.
  }
  return response.statusText || 'Jira request failed';
}

function issueContent(issue: z.infer<typeof JiraIssueSchema>): string {
  const links = issue.fields.issuelinks.flatMap((link) => {
    if (link.outwardIssue !== undefined) {
      return [{
        relationship: link.type.outward,
        key: link.outwardIssue.key,
        summary: link.outwardIssue.fields.summary,
      }];
    }
    if (link.inwardIssue !== undefined) {
      return [{
        relationship: link.type.inward,
        key: link.inwardIssue.key,
        summary: link.inwardIssue.fields.summary,
      }];
    }
    return [];
  });

  return JSON.stringify({
    key: issue.key,
    summary: issue.fields.summary,
    description: adfToText(issue.fields.description),
    status: issue.fields.status.name,
    issueType: issue.fields.issuetype.name,
    priority: issue.fields.priority?.name ?? null,
    labels: issue.fields.labels,
    components: issue.fields.components.map((item) => item.name),
    fixVersions: issue.fields.fixVersions.map((item) => item.name),
    parent: issue.fields.parent === undefined
      ? null
      : { key: issue.fields.parent.key, summary: issue.fields.parent.fields.summary },
    links,
    updated: issue.fields.updated,
  }, null, 2);
}

/**
 * Read-only Jira Cloud adapter. The query text must be exactly one issue key;
 * broader Jira search and comments are deliberately separate future adapters.
 */
export class JiraCloudKnowledgeSource implements KnowledgeSource {
  readonly #baseUrl: string;
  readonly #authorization: () => Promise<string | undefined>;
  readonly #httpClient: JiraHttpClient;
  readonly #timeoutMs: number;

  constructor(options: JiraCloudKnowledgeSourceOptions) {
    this.#baseUrl = normalizeBaseUrl(options.baseUrl);
    this.#authorization = options.authorization ?? (() => Promise.resolve(undefined));
    this.#httpClient = options.httpClient ?? defaultHttpClient;
    this.#timeoutMs = z.number().int().positive().max(60_000).parse(options.timeoutMs ?? 10_000);
  }

  async search(queryValue: KnowledgeQuery): Promise<readonly ContextEvidence[]> {
    const query = KnowledgeQuerySchema.parse(queryValue);
    if (!query.sources.includes('jira')) return [];

    const issueKey = JiraIssueKeySchema.parse(query.text.trim());
    const authorization = await this.#authorization();
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (authorization !== undefined && authorization.trim() !== '') {
      headers.Authorization = authorization;
    }
    const fields = [
      'summary',
      'description',
      'updated',
      'status',
      'issuetype',
      'priority',
      'labels',
      'components',
      'fixVersions',
      'parent',
      'issuelinks',
    ].join(',');
    const url = `${this.#baseUrl}/rest/api/3/issue/${encodeURIComponent(issueKey)}?fields=${fields}`;
    const response = await this.#httpClient(url, {
      method: 'GET',
      headers,
      redirect: 'error',
      signal: AbortSignal.timeout(this.#timeoutMs),
    });
    if (!response.ok) {
      throw new JiraApiError(response.status, await errorMessage(response));
    }

    const issue = JiraIssueSchema.parse(await response.json());
    if (issue.key !== issueKey) {
      throw new Error(`Jira returned issue '${issue.key}' for requested key '${issueKey}'.`);
    }
    const content = issueContent(issue);
    return [ContextEvidenceSchema.parse({
      id: `jira:${issue.id}:${issue.fields.updated}`,
      source: 'jira',
      uri: `${this.#baseUrl}/browse/${encodeURIComponent(issue.key)}`,
      revision: issue.fields.updated,
      retrievedAt: query.asOf,
      content,
      estimatedTokens: Math.max(1, Math.ceil(content.length / 4)),
      relevance: 1,
    })];
  }
}
