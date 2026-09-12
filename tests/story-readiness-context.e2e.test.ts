import { describe, expect, it } from 'vitest';
import type { ContextPack } from '../src/context.js';
import type {
  ModelGateway,
  ModelRequest,
  ModelResponse,
} from '../src/contracts.js';
import {
  GitHubRepositoryKnowledgeSource,
  type GitHubHttpClient,
} from '../src/github-repository.js';
import { InMemoryArtifactStore, InMemoryWorkflowStore } from '../src/in-memory-stores.js';
import { JiraCloudKnowledgeSource, type JiraHttpClient } from '../src/jira-cloud.js';
import { CompositeKnowledgeSource } from '../src/knowledge-assembler.js';
import { evaluateKnowledgeRetrieval } from '../src/knowledge-retrieval-eval.js';
import { runStoryReadinessWorkflow } from '../src/story-readiness-workflow.js';

const traceId = '30d43a8e-5160-4db6-a3a5-7096c304f861';
const repositoryRevision = 'a'.repeat(40);
const architectureRevision = 'b'.repeat(40);
const architectureEvidenceId =
  `github:acme/product:docs/adr-007.md:${architectureRevision}`;

class EvidenceAwareModel implements ModelGateway {
  context: ContextPack | undefined;

  async capabilities() {
    return [];
  }

  async generate(_request: ModelRequest, context: ContextPack): Promise<ModelResponse> {
    this.context = context;
    const jiraId = context.evidence.find((item) => item.source === 'jira')?.id;
    if (jiraId === undefined) throw new Error('Jira evidence was not assembled.');
    return {
      provider: 'offline-test',
      model: 'fixture',
      output: {
        storyKey: 'QE-42',
        summary: 'The story does not define the authorization behavior required by the ADR.',
        findings: [{
          id: 'FINDING-001',
          category: 'security',
          severity: 'blocking',
          summary: 'Service authorization is unspecified.',
          impact: 'The implementation cannot be verified against the architecture requirement.',
          basis: { kind: 'evidence', evidenceIds: [jiraId, architectureEvidenceId] },
        }],
        refinementQuestions: [{
          question: 'Which service identity and authorization policy must the request use?',
          resolvesFindingIds: ['FINDING-001'],
        }],
        suggestedAcceptanceCriteria: [
          'Eligibility requests enforce the authorization policy defined by ADR-007.',
        ],
        recommendedTestLayers: ['contract', 'api', 'security'],
      },
      usage: { inputTokens: 400, cachedInputTokens: 100, outputTokens: 120 },
      finishReason: 'completed',
    };
  }
}

describe('Story Readiness cross-source context', () => {
  it('combines an exact Jira lookup with semantic GitHub evidence without live access', async () => {
    let jiraRequestCount = 0;
    const httpClient: JiraHttpClient = async () => {
      jiraRequestCount += 1;
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({
          id: '10042',
          key: 'QE-42',
          fields: {
            summary: 'Submit an eligibility request',
            description: 'An active member can request their eligibility status.',
            updated: '2026-09-07T19:30:00.000+0000',
            status: { name: 'Refinement' },
            issuetype: { name: 'Story' },
            priority: { name: 'High' },
            labels: [],
            components: [{ name: 'Eligibility API' }],
            fixVersions: [],
            issuelinks: [],
          },
        }),
      };
    };
    const jira = new JiraCloudKnowledgeSource({
      baseUrl: 'https://example.atlassian.net',
      httpClient,
    });
    let githubRequestUrl = '';
    const githubHttpClient: GitHubHttpClient = async (url) => {
      githubRequestUrl = url;
      const content =
        'ADR-007 requires service-to-service authorization for eligibility requests.';
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({
          type: 'file',
          encoding: 'base64',
          size: Buffer.byteLength(content),
          path: 'docs/adr-007.md',
          sha: architectureRevision,
          content: Buffer.from(content).toString('base64'),
        }),
      };
    };
    const github = new GitHubRepositoryKnowledgeSource({
      repository: 'acme/product',
      revision: repositoryRevision,
      paths: ['docs/adr-007.md'],
      httpClient: githubHttpClient,
    });
    const model = new EvidenceAwareModel();
    const artifacts = new InMemoryArtifactStore();
    const workflows = new InMemoryWorkflowStore();

    const result = await runStoryReadinessWorkflow({
      traceId,
      storyKey: 'QE-42',
      objective: 'Assess QE-42 against product architecture.',
      queryText: 'eligibility request context',
      sourceQueries: {
        jira: 'QE-42',
        github: 'eligibility authorization architecture decision',
      },
      sources: ['jira', 'github'],
      asOf: '2026-09-07T20:00:00.000Z',
      maxResults: 10,
      maxContextTokens: 2_000,
    }, {
      knowledge: new CompositeKnowledgeSource({ jira, github }),
      model,
      artifacts,
      workflows,
      now: () => '2026-09-07T20:05:00.000Z',
    });

    expect(jiraRequestCount).toBe(1);
    expect(githubRequestUrl).toContain(
      `/contents/docs/adr-007.md?ref=${repositoryRevision}`,
    );
    expect(model.context?.evidence.map((item) => item.source).sort()).toEqual([
      'github',
      'jira',
    ]);
    expect(result.assessment).toMatchObject({ readinessScore: 70, decision: 'blocked' });
    const jiraEvidenceId = result.contextPack.evidence
      .find((item) => item.source === 'jira')?.id;
    expect(jiraEvidenceId).toBeDefined();
    expect(evaluateKnowledgeRetrieval(result.contextPack.evidence, {
      schemaVersion: '1.0',
      id: 'mocked-cross-source-workflow',
      query: 'eligibility authorization architecture decision',
      expectedRelevantEvidenceIds: [jiraEvidenceId!, architectureEvidenceId],
      requiredSources: ['jira', 'github'],
      thresholds: {
        k: 2,
        minimumRecallAtK: 1,
        minimumPrecisionAtK: 1,
        minimumReciprocalRank: 1,
        minimumSourceCoverage: 1,
      },
    })).toMatchObject({ passed: true, recallAtK: 1, sourceCoverage: 1 });
    expect(result.workflow.status).toBe('waiting-for-human');
    expect(await artifacts.listByTrace(traceId)).toHaveLength(2);
  });
});
