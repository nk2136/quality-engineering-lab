import { describe, expect, it } from 'vitest';
import type { ContextEvidence, ContextPack } from '../src/context.js';
import type {
  KnowledgeQuery,
  KnowledgeSource,
  ModelGateway,
  ModelRequest,
  ModelResponse,
} from '../src/contracts.js';
import { InMemoryArtifactStore, InMemoryWorkflowStore } from '../src/in-memory-stores.js';
import {
  runStoryReadinessWorkflow,
  type StoryReadinessWorkflowDependencies,
  type StoryReadinessWorkflowInput,
} from '../src/story-readiness-workflow.js';

const traceId = '3d594650-3436-4d7c-86a7-2b94788009bc';

const storyEvidence: ContextEvidence = {
  id: 'jira-story',
  source: 'jira',
  uri: 'https://example.atlassian.net/browse/QE-42',
  revision: '7',
  retrievedAt: '2026-08-31T20:00:00.000Z',
  content: 'Authorized users can submit a request.',
  estimatedTokens: 50,
  relevance: 1,
};

class StubKnowledgeSource implements KnowledgeSource {
  query: KnowledgeQuery | undefined;

  async search(query: KnowledgeQuery): Promise<readonly ContextEvidence[]> {
    this.query = query;
    return [storyEvidence];
  }
}

class StubModelGateway implements ModelGateway {
  request: ModelRequest | undefined;
  context: ContextPack | undefined;

  constructor(private readonly response: ModelResponse) {}

  async capabilities() {
    return [];
  }

  async generate(request: ModelRequest, context: ContextPack): Promise<ModelResponse> {
    this.request = request;
    this.context = context;
    return this.response;
  }
}

function modelResponse(output: unknown, finishReason: ModelResponse['finishReason'] = 'completed'):
  ModelResponse {
  return {
    provider: 'test-provider',
    model: 'test-model',
    output,
    usage: { inputTokens: 500, cachedInputTokens: 200, outputTokens: 150 },
    finishReason,
  };
}

function validDraft() {
  return {
    storyKey: 'QE-42',
    summary: 'The story has one minor clarification.',
    findings: [
      {
        id: 'FINDING-001',
        category: 'acceptance-criteria',
        severity: 'minor',
        summary: 'The success response is not explicit.',
        impact: 'The assertion could vary between implementations.',
        basis: { kind: 'evidence', evidenceIds: ['jira-story'] },
      },
    ],
    refinementQuestions: [
      { question: 'What response confirms success?', resolvesFindingIds: ['FINDING-001'] },
    ],
    suggestedAcceptanceCriteria: ['A successful request returns a documented response.'],
    recommendedTestLayers: ['api', 'integration'],
  };
}

function workflowInput(): StoryReadinessWorkflowInput {
  return {
    traceId,
    storyKey: 'QE-42',
    objective: 'Assess QE-42 for refinement readiness.',
    queryText: 'QE-42 request submission architecture and tests',
    sources: ['jira', 'github', 'test'],
    asOf: '2026-08-31T20:00:00.000Z',
    maxContextTokens: 1_000,
  };
}

function dependencies(model: StubModelGateway) {
  const knowledge = new StubKnowledgeSource();
  const artifacts = new InMemoryArtifactStore();
  const workflows = new InMemoryWorkflowStore();
  const value: StoryReadinessWorkflowDependencies = {
    knowledge,
    model,
    artifacts,
    workflows,
    now: () => '2026-08-31T20:05:00.000Z',
  };
  return { value, knowledge, artifacts, workflows };
}

describe('Story Readiness workflow', () => {
  it('retrieves evidence, validates the model draft, persists artifacts, and waits for a human', async () => {
    const model = new StubModelGateway(modelResponse(validDraft()));
    const { value, knowledge, artifacts } = dependencies(model);

    const result = await runStoryReadinessWorkflow(workflowInput(), value);

    expect(knowledge.query).toMatchObject({ traceId, maxResults: 20 });
    expect(model.request).toMatchObject({ task: 'reason', promptVersion: 'story-readiness-v1' });
    expect(model.context?.evidence.map((item) => item.id)).toEqual(['jira-story']);
    expect(result.assessment).toMatchObject({ readinessScore: 95, decision: 'ready' });
    expect(result.workflow).toMatchObject({
      status: 'waiting-for-human',
      version: 1,
      approval: { status: 'pending' },
    });
    expect(result.workflow.artifactIds).toEqual([
      `context-pack:${traceId}`,
      `story-readiness:${traceId}`,
    ]);

    const assessmentArtifact = await artifacts.get(`story-readiness:${traceId}`);
    expect(assessmentArtifact?.metadata).toMatchObject({
      promptVersion: 'story-readiness-v1',
      provider: 'test-provider',
      model: 'test-model',
      cachedInputTokens: '200',
    });
  });

  it('marks the workflow failed when the model invents an evidence citation', async () => {
    const invalidDraft = validDraft();
    invalidDraft.findings[0]!.basis.evidenceIds = ['invented-source'];
    const model = new StubModelGateway(modelResponse(invalidDraft));
    const { value, workflows, artifacts } = dependencies(model);

    await expect(runStoryReadinessWorkflow(workflowInput(), value)).rejects.toThrow(
      "Finding 'FINDING-001' cites unknown evidence: invented-source.",
    );

    const state = await workflows.get(`story-readiness:QE-42:${traceId}`);
    expect(state).toMatchObject({ status: 'failed', version: 1 });
    expect(state?.artifactIds).toEqual([`context-pack:${traceId}`]);
    expect(await artifacts.get(`story-readiness:${traceId}`)).toBeUndefined();
  });

  it('rejects incomplete model responses and preserves the context artifact for diagnosis', async () => {
    const model = new StubModelGateway(modelResponse(validDraft(), 'length'));
    const { value, workflows, artifacts } = dependencies(model);

    await expect(runStoryReadinessWorkflow(workflowInput(), value)).rejects.toThrow(
      'Story Readiness model run did not complete: length.',
    );

    expect(await artifacts.get(`context-pack:${traceId}`)).toBeDefined();
    expect(await workflows.get(`story-readiness:QE-42:${traceId}`)).toMatchObject({
      status: 'failed',
    });
  });

  it('rejects a valid draft produced for a different story', async () => {
    const model = new StubModelGateway(
      modelResponse({ ...validDraft(), storyKey: 'QE-99' }),
    );
    const { value, workflows } = dependencies(model);

    await expect(runStoryReadinessWorkflow(workflowInput(), value)).rejects.toThrow(
      "Story Readiness response key 'QE-99' does not match requested story 'QE-42'.",
    );

    expect(await workflows.get(`story-readiness:QE-42:${traceId}`)).toMatchObject({
      status: 'failed',
    });
  });
});
