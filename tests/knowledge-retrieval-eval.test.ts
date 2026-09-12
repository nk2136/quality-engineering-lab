import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { ContextEvidence } from '../src/context.js';
import {
  KnowledgeRetrievalGoldenCaseSchema,
  evaluateKnowledgeRetrieval,
  type KnowledgeRetrievalGoldenCase,
} from '../src/knowledge-retrieval-eval.js';

const corpus = KnowledgeRetrievalGoldenCaseSchema.array().parse(JSON.parse(readFileSync(
  new URL('../evals/knowledge-retrieval-cases.json', import.meta.url),
  'utf8',
)));

function goldenCase(id: string): KnowledgeRetrievalGoldenCase {
  const result = corpus.find((item) => item.id === id);
  if (result === undefined) throw new Error(`Knowledge retrieval case '${id}' was not found.`);
  return result;
}

function evidence(id: string, source: ContextEvidence['source']): ContextEvidence {
  return {
    id,
    source,
    uri: `https://example.test/${id}`,
    revision: '1',
    retrievedAt: '2026-09-12T20:00:00.000Z',
    content: `Evidence for ${id}`,
    estimatedTokens: 10,
    relevance: 1,
  };
}

describe('knowledge retrieval evaluation', () => {
  it('validates a corpus covering architecture and historical test evidence', () => {
    expect(corpus).toHaveLength(2);
    expect(new Set(corpus.flatMap((item) => item.requiredSources))).toEqual(
      new Set(['jira', 'github', 'ci']),
    );
  });

  it('passes complete, precise, cross-source retrieval', () => {
    const report = evaluateKnowledgeRetrieval([
      evidence('jira-story', 'jira'),
      evidence('github-authorization-adr', 'github'),
    ], goldenCase('story-and-authorization-architecture'));

    expect(report).toMatchObject({
      passed: true,
      recallAtK: 1,
      precisionAtK: 1,
      reciprocalRank: 1,
      sourceCoverage: 1,
      missingEvidenceIds: [],
      unexpectedEvidenceIds: [],
    });
  });

  it('reports missing evidence and source coverage independently', () => {
    const report = evaluateKnowledgeRetrieval([
      evidence('jira-story', 'jira'),
    ], goldenCase('story-and-authorization-architecture'));

    expect(report).toMatchObject({
      passed: false,
      recallAtK: 0.5,
      precisionAtK: 1,
      sourceCoverage: 0.5,
      missingEvidenceIds: ['github-authorization-adr'],
      missingSources: ['github'],
    });
  });

  it('measures irrelevant ranking through precision and reciprocal rank', () => {
    const report = evaluateKnowledgeRetrieval([
      evidence('unrelated-runbook', 'github'),
      evidence('jira-story', 'jira'),
      evidence('github-authorization-adr', 'github'),
    ], goldenCase('story-and-authorization-architecture'));

    expect(report.precisionAtK).toBeCloseTo(2 / 3);
    expect(report.reciprocalRank).toBe(0.5);
    expect(report.unexpectedEvidenceIds).toEqual(['unrelated-runbook']);
    expect(report.passed).toBe(false);
  });

  it('fails duplicate evidence even when threshold metrics pass', () => {
    const report = evaluateKnowledgeRetrieval([
      evidence('jira-story', 'jira'),
      evidence('github-authorization-adr', 'github'),
      evidence('github-authorization-adr', 'github'),
    ], goldenCase('story-and-authorization-architecture'));

    expect(report.recallAtK).toBe(1);
    expect(report.duplicateEvidenceIds).toEqual(['github-authorization-adr']);
    expect(report.passed).toBe(false);
  });
});
