import { z } from 'zod';
import { ContextEvidenceSchema, type ContextEvidence } from './context.js';
import { KnowledgeQuerySchema, type KnowledgeQuery, type KnowledgeSource } from './contracts.js';

const GitObjectIdSchema = z.string().regex(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/);
const RepositorySchema = z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);

const GitHubFileSchema = z.object({
  type: z.literal('file'),
  encoding: z.literal('base64'),
  size: z.number().int().nonnegative(),
  path: z.string().min(1),
  sha: GitObjectIdSchema,
  content: z.string(),
});

export interface GitHubHttpResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly statusText: string;
  json(): Promise<unknown>;
}

export interface GitHubHttpRequest {
  method: 'GET';
  headers: Readonly<Record<string, string>>;
  redirect: 'error';
  signal: AbortSignal;
}

export type GitHubHttpClient = (
  url: string,
  request: GitHubHttpRequest,
) => Promise<GitHubHttpResponse>;

export interface GitHubRepositoryKnowledgeSourceOptions {
  repository: string;
  revision: string;
  paths: readonly string[];
  authorization?: () => Promise<string | undefined>;
  httpClient?: GitHubHttpClient;
  timeoutMs?: number;
  maxFileBytes?: number;
}

export class GitHubApiError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    message: string,
  ) {
    super(message);
    this.name = 'GitHubApiError';
  }
}

function validatePath(value: string): string {
  const path = z.string().min(1).parse(value);
  const segments = path.split('/');
  if (
    path.startsWith('/') ||
    path.endsWith('/') ||
    path.includes('\\') ||
    path.includes('?') ||
    path.includes('#') ||
    segments.some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    throw new Error(`GitHub repository path '${path}' must be a normalized relative file path.`);
  }
  return path;
}

function defaultHttpClient(
  url: string,
  request: GitHubHttpRequest,
): Promise<GitHubHttpResponse> {
  return fetch(url, request);
}

function decodeBase64(content: string, maxBytes: number, path: string): Uint8Array {
  const normalized = content.replace(/\s/g, '');
  if (normalized.length > Math.ceil(maxBytes / 3) * 4) {
    throw new Error(`GitHub file '${path}' exceeds the ${maxBytes}-byte limit.`);
  }
  if (normalized.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(normalized)) {
    throw new Error('GitHub returned invalid Base64 file content.');
  }
  return Buffer.from(normalized, 'base64');
}

function tokenize(value: string): Set<string> {
  return new Set(value.toLowerCase().match(/[a-z0-9_]{2,}/g) ?? []);
}

function relevance(query: string, path: string, content: string): number {
  const queryTokens = tokenize(query);
  if (queryTokens.size === 0) return 0;
  const documentTokens = tokenize(`${path} ${content}`);
  let matched = 0;
  for (const token of queryTokens) {
    if (documentTokens.has(token)) matched += 1;
  }
  return matched / queryTokens.size;
}

async function errorMessage(response: GitHubHttpResponse): Promise<string> {
  try {
    const body = z.object({ message: z.string().min(1) }).safeParse(await response.json());
    if (body.success) return body.data.message.slice(0, 500);
  } catch {
    // Retain a status-based error if GitHub returns a non-JSON response.
  }
  return response.statusText || 'GitHub request failed';
}

/**
 * Reads an explicit set of UTF-8 files from one repository revision. The
 * adapter has no repository discovery, code search, branch lookup, or writes.
 */
export class GitHubRepositoryKnowledgeSource implements KnowledgeSource {
  readonly #repository: string;
  readonly #revision: string;
  readonly #paths: readonly string[];
  readonly #authorization: () => Promise<string | undefined>;
  readonly #httpClient: GitHubHttpClient;
  readonly #timeoutMs: number;
  readonly #maxFileBytes: number;

  constructor(options: GitHubRepositoryKnowledgeSourceOptions) {
    this.#repository = RepositorySchema.parse(options.repository);
    this.#revision = GitObjectIdSchema.parse(options.revision);
    const paths = z.array(z.string()).min(1).max(50).parse([...options.paths]).map(validatePath);
    if (new Set(paths).size !== paths.length) {
      throw new Error('GitHub repository paths must be unique.');
    }
    this.#paths = paths;
    this.#authorization = options.authorization ?? (() => Promise.resolve(undefined));
    this.#httpClient = options.httpClient ?? defaultHttpClient;
    this.#timeoutMs = z.number().int().positive().max(60_000).parse(options.timeoutMs ?? 10_000);
    this.#maxFileBytes = z.number().int().positive().max(1_000_000)
      .parse(options.maxFileBytes ?? 250_000);
  }

  async search(queryValue: KnowledgeQuery): Promise<readonly ContextEvidence[]> {
    const query = KnowledgeQuerySchema.parse(queryValue);
    if (!query.sources.includes('github')) return [];

    const authorization = await this.#authorization();
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2026-03-10',
      'User-Agent': 'quality-engineering-lab',
    };
    if (authorization !== undefined && authorization.trim() !== '') {
      headers.Authorization = authorization;
    }

    const files = await Promise.all(this.#paths.map(async (path) => {
      const encodedPath = path.split('/').map(encodeURIComponent).join('/');
      const url = `https://api.github.com/repos/${this.#repository}/contents/${encodedPath}?ref=${this.#revision}`;
      const response = await this.#httpClient(url, {
        method: 'GET',
        headers,
        redirect: 'error',
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
      if (!response.ok) {
        throw new GitHubApiError(response.status, path, await errorMessage(response));
      }

      const file = GitHubFileSchema.parse(await response.json());
      if (file.path !== path) {
        throw new Error(`GitHub returned path '${file.path}' for requested path '${path}'.`);
      }
      if (file.size > this.#maxFileBytes) {
        throw new Error(`GitHub file '${path}' exceeds the ${this.#maxFileBytes}-byte limit.`);
      }
      const bytes = decodeBase64(file.content, this.#maxFileBytes, path);
      if (bytes.byteLength !== file.size) {
        throw new Error(`GitHub file '${path}' size does not match its decoded content.`);
      }
      const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      const score = relevance(query.text, path, content);
      return ContextEvidenceSchema.parse({
        id: `github:${this.#repository}:${path}:${file.sha}`,
        source: 'github',
        uri: `https://github.com/${this.#repository}/blob/${this.#revision}/${encodedPath}`,
        revision: file.sha,
        retrievedAt: query.asOf,
        content,
        estimatedTokens: Math.max(1, Math.ceil(content.length / 4)),
        relevance: score,
      });
    }));

    return files
      .filter((file) => file.relevance > 0)
      .sort((left, right) => right.relevance - left.relevance || left.id.localeCompare(right.id))
      .slice(0, query.maxResults);
  }
}
