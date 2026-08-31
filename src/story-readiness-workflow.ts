import { z } from 'zod';
import {
  EvidenceSourceSchema,
  buildContextPack,
  type ContextPack,
} from './context.js';
import {
  ModelRequestSchema,
  ModelResponseSchema,
  type ArtifactRecord,
  type ArtifactStore,
  type KnowledgeSource,
  type ModelGateway,
  type WorkflowState,
  type WorkflowStore,
} from './contracts.js';
import {
  StoryReadinessDraftSchema,
  finalizeStoryReadiness,
  type StoryReadinessAssessment,
} from './story-readiness.js';

const ContextSeedSchema = z.object({
  acceptanceCriteria: z.array(z.string().min(1)).default([]),
  constraints: z.array(z.string().min(1)).default([]),
  architectureFacts: z.array(z.string().min(1)).default([]),
  ownershipFacts: z.array(z.string().min(1)).default([]),
  priorSignals: z.array(z.string().min(1)).default([]),
  contradictions: z.array(z.string().min(1)).default([]),
  missingEvidence: z.array(z.string().min(1)).default([]),
});

export const StoryReadinessWorkflowInputSchema = z.object({
  traceId: z.string().uuid(),
  storyKey: z.string().regex(/^[A-Z][A-Z0-9_]*-\d+$/),
  objective: z.string().min(1),
  queryText: z.string().min(1),
  sources: z.array(EvidenceSourceSchema).min(1),
  asOf: z.string().datetime(),
  maxResults: z.number().int().positive().default(20),
  maxContextTokens: z.number().int().positive(),
  reservedTokens: z.number().int().nonnegative().default(0),
  maxOutputTokens: z.number().int().positive().default(2_000),
  contextSeed: ContextSeedSchema.default({
    acceptanceCriteria: [],
    constraints: [],
    architectureFacts: [],
    ownershipFacts: [],
    priorSignals: [],
    contradictions: [],
    missingEvidence: [],
  }),
});

export type StoryReadinessWorkflowInput = z.input<typeof StoryReadinessWorkflowInputSchema>;

export interface StoryReadinessWorkflowDependencies {
  knowledge: KnowledgeSource;
  model: ModelGateway;
  artifacts: ArtifactStore;
  workflows: WorkflowStore;
  now: () => string;
}

export interface StoryReadinessWorkflowResult {
  contextPack: ContextPack;
  assessment: StoryReadinessAssessment;
  workflow: WorkflowState;
}

const promptVersion = 'story-readiness-v1';

function sourceRevisions(evidence: ContextPack['evidence']): Record<string, string> {
  return Object.fromEntries(
    evidence
      .map((item) => [`${item.source}:${item.uri}`, item.revision] as const)
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

function timestamp(now: () => string): string {
  return z.string().datetime().parse(now());
}

/**
 * Executes the read-only Story Readiness vertical slice. The workflow stops in
 * a human-review state and intentionally performs no Jira write-back.
 */
export async function runStoryReadinessWorkflow(
  inputValue: StoryReadinessWorkflowInput,
  dependencies: StoryReadinessWorkflowDependencies,
): Promise<StoryReadinessWorkflowResult> {
  const input = StoryReadinessWorkflowInputSchema.parse(inputValue);
  const workflowId = `story-readiness:${input.storyKey}:${input.traceId}`;
  const contextArtifactId = `context-pack:${input.traceId}`;
  const assessmentArtifactId = `story-readiness:${input.traceId}`;
  const persistedArtifactIds: string[] = [];
  const initialWorkflow: WorkflowState = {
    id: workflowId,
    traceId: input.traceId,
    stage: 'refinement',
    status: 'running',
    version: 0,
    updatedAt: timestamp(dependencies.now),
    artifactIds: [],
    approval: { status: 'pending', reviewer: null, reviewedAt: null },
  };

  await dependencies.workflows.create(initialWorkflow);

  try {
    const evidence = await dependencies.knowledge.search({
      traceId: input.traceId,
      text: input.queryText,
      sources: input.sources,
      maxResults: input.maxResults,
      asOf: input.asOf,
    });

    const evidenceCandidates = [...evidence];
    const contextPack = buildContextPack({
      traceId: input.traceId,
      objective: input.objective,
      stage: 'refinement',
      sourceRevisions: sourceRevisions(evidenceCandidates),
      ...input.contextSeed,
      candidates: evidenceCandidates,
      maxTokens: input.maxContextTokens,
      reservedTokens: input.reservedTokens,
    });

    const contextArtifact: ArtifactRecord = {
      id: contextArtifactId,
      traceId: input.traceId,
      kind: 'context-pack',
      schemaVersion: contextPack.schemaVersion,
      createdAt: timestamp(dependencies.now),
      content: contextPack,
      metadata: {
        storyKey: input.storyKey,
        evidenceCount: String(contextPack.evidence.length),
        truncated: String(contextPack.truncated),
      },
    };
    await dependencies.artifacts.put(contextArtifact);
    persistedArtifactIds.push(contextArtifactId);

    const request = ModelRequestSchema.parse({
      traceId: input.traceId,
      task: 'reason',
      promptVersion,
      input: JSON.stringify({
        storyKey: input.storyKey,
        objective: input.objective,
        instruction:
          'Return only a StoryReadinessDraft. Base every finding on the supplied context pack.',
      }),
      maxOutputTokens: input.maxOutputTokens,
    });
    const response = ModelResponseSchema.parse(
      await dependencies.model.generate(request, contextPack),
    );
    if (response.finishReason !== 'completed') {
      throw new Error(`Story Readiness model run did not complete: ${response.finishReason}.`);
    }

    const draft = StoryReadinessDraftSchema.parse(response.output);
    if (draft.storyKey !== input.storyKey) {
      throw new Error(
        `Story Readiness response key '${draft.storyKey}' does not match requested story '${input.storyKey}'.`,
      );
    }
    const assessment = finalizeStoryReadiness(draft, contextPack);
    const assessmentArtifact: ArtifactRecord = {
      id: assessmentArtifactId,
      traceId: input.traceId,
      kind: 'story-readiness',
      schemaVersion: assessment.schemaVersion,
      createdAt: timestamp(dependencies.now),
      content: assessment,
      metadata: {
        storyKey: input.storyKey,
        promptVersion,
        provider: response.provider,
        model: response.model,
        inputTokens: String(response.usage.inputTokens),
        cachedInputTokens: String(response.usage.cachedInputTokens),
        outputTokens: String(response.usage.outputTokens),
      },
    };
    await dependencies.artifacts.put(assessmentArtifact);
    persistedArtifactIds.push(assessmentArtifactId);

    const workflow = await dependencies.workflows.save(
      {
        ...initialWorkflow,
        status: 'waiting-for-human',
        updatedAt: timestamp(dependencies.now),
        artifactIds: [...persistedArtifactIds],
      },
      0,
    );

    return { contextPack, assessment, workflow };
  } catch (error) {
    try {
      await dependencies.workflows.save(
        {
          ...initialWorkflow,
          status: 'failed',
          updatedAt: timestamp(dependencies.now),
          artifactIds: [...persistedArtifactIds],
        },
        0,
      );
    } catch (persistenceError) {
      throw new AggregateError(
        [error, persistenceError],
        `Story Readiness workflow '${workflowId}' failed and its failure state could not be persisted.`,
      );
    }
    throw error;
  }
}
