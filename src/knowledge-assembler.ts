import { z } from 'zod';
import {
  ContextEvidenceSchema,
  EvidenceSourceSchema,
  type ContextEvidence,
} from './context.js';
import {
  KnowledgeQuerySchema,
  type KnowledgeQuery,
  type KnowledgeSource,
} from './contracts.js';

export type EvidenceSource = z.infer<typeof EvidenceSourceSchema>;

export const SourceQuerySchema = z.object({
  source: EvidenceSourceSchema,
  text: z.string().min(1),
  maxResults: z.number().int().positive(),
});

export const KnowledgeAssemblyRequestSchema = z
  .object({
    traceId: z.string().uuid(),
    asOf: z.string().datetime(),
    queries: z.array(SourceQuerySchema).min(1),
    maxTotalResults: z.number().int().positive(),
  })
  .superRefine((request, context) => {
    const seen = new Set<EvidenceSource>();
    request.queries.forEach((query, index) => {
      if (seen.has(query.source)) {
        context.addIssue({
          code: 'custom',
          path: ['queries', index, 'source'],
          message: `Knowledge assembly has more than one query for '${query.source}'.`,
        });
      }
      seen.add(query.source);
    });
  });

export type KnowledgeAssemblyRequest = z.input<typeof KnowledgeAssemblyRequestSchema>;

function compareEvidence(left: ContextEvidence, right: ContextEvidence): number {
  return (
    right.relevance - left.relevance ||
    right.retrievedAt.localeCompare(left.retrievedAt) ||
    left.id.localeCompare(right.id)
  );
}

/**
 * Routes one source-specific query at a time. Adapters cannot accidentally see
 * another adapter's query language or credentials.
 */
export class CompositeKnowledgeSource implements KnowledgeSource {
  readonly #sources: Partial<Record<EvidenceSource, KnowledgeSource>>;

  constructor(sources: Partial<Record<EvidenceSource, KnowledgeSource>>) {
    this.#sources = { ...sources };
  }

  async search(queryValue: KnowledgeQuery): Promise<readonly ContextEvidence[]> {
    const query = KnowledgeQuerySchema.parse(queryValue);
    if (query.sources.length !== 1) {
      throw new Error('Composite knowledge queries must target exactly one source.');
    }

    const source = query.sources[0]!;
    const adapter = this.#sources[source];
    if (adapter === undefined) {
      throw new Error(`No knowledge adapter is configured for '${source}'.`);
    }
    return adapter.search(query);
  }
}

/**
 * Executes a bounded query plan and produces deterministic, source-validated
 * evidence. Global deduplication protects the context budget when adapters
 * expose the same revision through overlapping indexes.
 */
export async function assembleKnowledge(
  requestValue: KnowledgeAssemblyRequest,
  knowledge: KnowledgeSource,
): Promise<readonly ContextEvidence[]> {
  const request = KnowledgeAssemblyRequestSchema.parse(requestValue);
  const batches = await Promise.all(
    request.queries.map(async (plannedQuery) => {
      const query = KnowledgeQuerySchema.parse({
        traceId: request.traceId,
        text: plannedQuery.text,
        sources: [plannedQuery.source],
        maxResults: plannedQuery.maxResults,
        asOf: request.asOf,
      });
      const evidence = z.array(ContextEvidenceSchema).parse(await knowledge.search(query));
      for (const item of evidence) {
        if (item.source !== plannedQuery.source) {
          throw new Error(
            `Knowledge adapter for '${plannedQuery.source}' returned '${item.source}' evidence '${item.id}'.`,
          );
        }
      }
      return evidence;
    }),
  );

  const seen = new Set<string>();
  const assembled: ContextEvidence[] = [];
  for (const item of batches.flat().sort(compareEvidence)) {
    const revisionKey = `${item.source}\u0000${item.uri}\u0000${item.revision}`;
    if (seen.has(revisionKey)) continue;
    seen.add(revisionKey);
    assembled.push(item);
    if (assembled.length === request.maxTotalResults) break;
  }
  return assembled;
}
