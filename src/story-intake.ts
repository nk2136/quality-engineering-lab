import { z } from 'zod';
import { createHash } from 'node:crypto';
import { ContextEvidenceSchema, type ContextEvidence } from './context.js';
import {
  ArtifactRecordSchema,
  DuplicateRecordError,
  RecordIdSchema,
  type ArtifactStore,
  type KnowledgeSource,
  type WorkflowState,
  type WorkflowStore,
} from './contracts.js';
import { LifecycleCoordinator } from './lifecycle-coordinator.js';

const IssueKeySchema = z.string().regex(/^[A-Z][A-Z0-9_]*-\d+$/);

export const StoryAssignmentSchema = z.object({
  assignmentId: RecordIdSchema,
  assignee: z.string().trim().min(1),
  traceId: z.string().uuid(),
  provider: z.string().min(1),
  issueKey: IssueKeySchema,
  sourceRevision: z.string().trim().min(1),
  workType: z.string().min(1).optional(),
  assignmentType: z.string().min(1).optional(),
  asOf: z.string().datetime().optional(),
}).superRefine((assignment, context) => {
  if (assignment.workType === undefined && assignment.assignmentType === undefined) {
    context.addIssue({
      code: 'custom',
      path: ['workType'],
      message: 'A story assignment must declare its work type.',
    });
  }
});

export type StoryAssignment = z.input<typeof StoryAssignmentSchema>;

export interface StoryIntakePolicy {
  readonly allowedIssueKeys: readonly string[];
}

export interface StoryIntakeDependencies {
  readonly knowledge: KnowledgeSource;
  readonly workflows: WorkflowStore;
  readonly artifacts: ArtifactStore;
  readonly now?: () => string;
}

export interface StoryIntakeResult {
  readonly assignmentId: string;
  readonly storyKey: string;
  readonly provider: 'jira';
  readonly revision: string;
  readonly evidence: ContextEvidence;
  readonly workflow: WorkflowState;
}

export class NonSdetAssignmentError extends Error {
  constructor(workType: string) {
    super(`Story assignment work type '${workType}' is not an SDET assignment.`);
    this.name = 'NonSdetAssignmentError';
  }
}

export { NonSdetAssignmentError as NonSDETAssignmentError };

export class UnsupportedStoryProviderError extends Error {
  constructor(provider: string) {
    super(`Story assignment provider '${provider}' is not supported.`);
    this.name = 'UnsupportedStoryProviderError';
  }
}

export class StoryNotAllowlistedError extends Error {
  constructor(issueKey: string) {
    super(`Story '${issueKey}' is not in the configured allowlist.`);
    this.name = 'StoryNotAllowlistedError';
  }
}

export class StoryAssignmentReplayMismatchError extends Error {
  constructor(assignmentId: string) {
    super(`Story assignment '${assignmentId}' replay does not match its original fingerprint.`);
    this.name = 'StoryAssignmentReplayMismatchError';
  }
}

const IntakeArtifactContentSchema = z.object({
  assignmentId: RecordIdSchema,
  assignee: z.string().trim().min(1),
  storyKey: IssueKeySchema,
  provider: z.literal('jira'),
  sourceRevision: z.string().trim().min(1),
  revision: z.string().min(1),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  evidence: ContextEvidenceSchema,
});

type ParsedStoryAssignment = z.infer<typeof StoryAssignmentSchema>;

function timestamp(now: () => string): string {
  return z.string().datetime().parse(now());
}

function validatedPolicy(policy: StoryIntakePolicy): ReadonlySet<string> {
  const keys = z.array(IssueKeySchema).min(1).parse([...policy.allowedIssueKeys]);
  if (new Set(keys).size !== keys.length) {
    throw new Error('Story issue allowlist must not contain duplicate keys.');
  }
  return new Set(keys);
}

function assignmentFingerprint(input: ParsedStoryAssignment): string {
  return createHash('sha256').update(JSON.stringify({
    assignmentId: input.assignmentId,
    assignee: input.assignee,
    traceId: input.traceId,
    provider: input.provider,
    issueKey: input.issueKey,
    sourceRevision: input.sourceRevision,
    workType: input.workType ?? null,
    assignmentType: input.assignmentType ?? null,
    asOf: input.asOf ?? null,
  })).digest('hex');
}

/**
 * Routes one explicitly assigned SDET story into the refinement lifecycle.
 * Provider scope and the exact story allowlist are checked before the source
 * adapter can resolve credentials or perform I/O.
 */
export class StoryIntakeRouter {
  readonly #allowedIssueKeys: ReadonlySet<string>;
  readonly #knowledge: KnowledgeSource;
  readonly #artifacts: ArtifactStore;
  readonly #coordinator: LifecycleCoordinator;
  readonly #now: () => string;
  readonly #inFlight = new Map<string, Promise<StoryIntakeResult>>();

  constructor(policy: StoryIntakePolicy, dependencies: StoryIntakeDependencies) {
    this.#allowedIssueKeys = validatedPolicy(policy);
    this.#knowledge = dependencies.knowledge;
    this.#artifacts = dependencies.artifacts;
    this.#now = dependencies.now ?? (() => new Date().toISOString());
    this.#coordinator = new LifecycleCoordinator(dependencies.workflows, this.#now);
  }

  async intake(inputValue: StoryAssignment): Promise<StoryIntakeResult> {
    const input = StoryAssignmentSchema.parse(inputValue);
    const workType = input.workType ?? input.assignmentType!;
    if (workType.toLowerCase() !== 'sdet') throw new NonSdetAssignmentError(workType);
    if (input.provider !== 'jira') throw new UnsupportedStoryProviderError(input.provider);
    if (!this.#allowedIssueKeys.has(input.issueKey)) {
      throw new StoryNotAllowlistedError(input.issueKey);
    }

    const workflowId = `story-intake:${input.assignmentId}`;
    const pending = this.#inFlight.get(workflowId);
    if (pending !== undefined) return pending;
    const operation = this.#intakeValidated(input, workflowId);
    this.#inFlight.set(workflowId, operation);
    try {
      return await operation;
    } finally {
      this.#inFlight.delete(workflowId);
    }
  }

  async #intakeValidated(
    input: z.infer<typeof StoryAssignmentSchema>,
    workflowId: string,
  ): Promise<StoryIntakeResult> {
    const existingWorkflow = await this.#coordinator.resume(workflowId).catch((error: unknown) => {
      if (error instanceof Error && error.message === `Workflow '${workflowId}' does not exist.`) {
        return undefined;
      }
      throw error;
    });
    if (existingWorkflow !== undefined) {
      if (existingWorkflow.traceId !== input.traceId) {
        throw new DuplicateRecordError('Workflow', workflowId);
      }
      const artifact = await this.#artifacts.get(`story-intake:${input.assignmentId}`);
      if (artifact === undefined) throw new Error(`Story intake artifact '${input.assignmentId}' is missing.`);
      return this.#resultFromArtifact(artifact, existingWorkflow, input);
    }

    const existingArtifact = await this.#artifacts.get(`story-intake:${input.assignmentId}`);
    if (existingArtifact !== undefined) {
      if (existingArtifact.traceId !== input.traceId) {
        throw new DuplicateRecordError('Artifact', existingArtifact.id);
      }
      const workflow = await this.#coordinator.start({
        id: workflowId,
        traceId: input.traceId,
        stage: 'refinement',
      });
      return this.#resultFromArtifact(existingArtifact, workflow, input);
    }

    const evidence = await this.#retrieve(input);
    const artifactId = `story-intake:${input.assignmentId}`;
    const artifact = ArtifactRecordSchema.parse({
      id: artifactId,
      traceId: input.traceId,
      kind: 'requirement-analysis',
      schemaVersion: '1.0',
      createdAt: timestamp(this.#now),
      content: {
        assignmentId: input.assignmentId,
        assignee: input.assignee,
        storyKey: input.issueKey,
        provider: 'jira',
        sourceRevision: input.sourceRevision,
        revision: evidence.revision,
        fingerprint: assignmentFingerprint(input),
        evidence,
      },
      metadata: {
        assignee: input.assignee,
        storyKey: input.issueKey,
        provider: 'jira',
        sourceRevision: input.sourceRevision,
        revision: evidence.revision,
        fingerprint: assignmentFingerprint(input),
      },
    });
    try {
      await this.#artifacts.put(artifact);
    } catch (error) {
      if (!(error instanceof DuplicateRecordError)) throw error;
    }

    const workflow = await this.#coordinator.start({
      id: workflowId,
      traceId: input.traceId,
      stage: 'refinement',
    });
    const storedArtifact = await this.#artifacts.get(artifactId);
    if (storedArtifact === undefined) throw new Error(`Story intake artifact '${artifactId}' is missing.`);
    return this.#resultFromArtifact(storedArtifact, workflow, input);
  }

  async #retrieve(input: ParsedStoryAssignment): Promise<ContextEvidence> {
    const asOf = input.asOf ?? timestamp(this.#now);
    const evidence = z.array(ContextEvidenceSchema).parse(await this.#knowledge.search({
      traceId: input.traceId,
      text: input.issueKey,
      sources: ['jira'],
      maxResults: 1,
      asOf,
    }));
    const story = evidence.find((item) => item.source === 'jira');
    if (story === undefined) {
      throw new Error(`Jira adapter returned no evidence for story '${input.issueKey}'.`);
    }
    if (story.revision !== input.sourceRevision) {
      throw new Error(
        `Jira source revision '${story.revision}' does not match pinned assignment revision '${input.sourceRevision}'.`,
      );
    }
    return story;
  }

  #resultFromArtifact(
    artifactValue: Awaited<ReturnType<ArtifactStore['get']>>,
    workflow: WorkflowState,
    input: ParsedStoryAssignment,
  ): StoryIntakeResult {
    if (artifactValue === undefined) throw new Error('Story intake artifact is missing.');
    const content = IntakeArtifactContentSchema.parse(artifactValue.content);
    if (
      artifactValue.traceId !== input.traceId ||
      content.assignmentId !== input.assignmentId ||
      content.assignee !== input.assignee ||
      content.storyKey !== input.issueKey ||
      content.provider !== input.provider ||
      content.sourceRevision !== input.sourceRevision ||
      content.revision !== input.sourceRevision ||
      content.fingerprint !== assignmentFingerprint(input)
    ) {
      throw new StoryAssignmentReplayMismatchError(input.assignmentId);
    }
    const { assignmentId, storyKey, provider, revision, evidence } = content;
    return { assignmentId, storyKey, provider, revision, evidence, workflow };
  }
}

export function createStoryIntakeRouter(
  policy: StoryIntakePolicy,
  dependencies: StoryIntakeDependencies,
): StoryIntakeRouter {
  return new StoryIntakeRouter(policy, dependencies);
}

export async function intakeStoryAssignment(
  input: StoryAssignment,
  policy: StoryIntakePolicy,
  dependencies: StoryIntakeDependencies,
): Promise<StoryIntakeResult> {
  return createStoryIntakeRouter(policy, dependencies).intake(input);
}
