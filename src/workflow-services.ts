import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  ArtifactRecordSchema,
  type ArtifactRecord,
  type ArtifactStore,
  type WorkflowStore,
} from './contracts.js';
import { type ContextEvidence, ContextEvidenceSchema } from './context.js';
import { AutomationEngineer, type AutomationPlan } from './automation-engineer.js';
import { AutomationReviewer, type AutomationReview } from './automation-review.js';
import { buildTestDesign, type TestDesign } from './test-design.js';
import { reviewTestDesign, type TestDesignReview } from './test-design-review.js';
import {
  RequirementsInvestigator,
  RequirementsInvestigationRequestSchema,
  type RequirementsInvestigatorDependencies,
} from './requirements-investigator.js';
import { buildDiscrepancyAnalysis, type DiscrepancyAnalysisReport } from './discrepancy-analysis.js';
import { publishReadinessHandoffArtifacts, type ReadinessHandoffArtifacts } from './handoff-artifacts.js';
import { validateReadinessPackage } from './readiness-validator.js';
import { routeVerification, type LocalExecutor, type VerificationRoutingInput, type VerificationRoutingResult } from './verification-routing.js';
import { LifecycleCoordinator } from './lifecycle-coordinator.js';

const WorkflowIdSchema = z.string().min(1);

export interface WorkflowServiceOptions {
  readonly workflows: WorkflowStore;
  readonly artifacts: ArtifactStore;
  readonly requirements?: RequirementsInvestigatorDependencies;
  /** Named read-only source ports for live or local evidence providers. */
  readonly knowledgeSources?: RequirementsInvestigatorDependencies;
  readonly execute?: LocalExecutor;
  readonly now?: () => string;
}

export interface RequirementsServiceInput {
  readonly workflowId?: string;
  readonly traceId: string;
  readonly storyKey: string;
  readonly sourceRevision: string;
  readonly asOf: string;
  readonly component?: string;
  readonly maxResults?: number;
}

export interface RequirementsServiceResult {
  readonly status: 'ready' | 'waiting-for-human';
  readonly readinessPackage: ReturnType<typeof validateReadinessPackage>;
  readonly artifacts: ReadonlyArray<ArtifactRecord>;
  readonly questions: readonly string[];
}

export interface PublishedArtifactResult<T> {
  readonly status: 'ready' | 'blocked' | 'waiting-for-human';
  readonly artifact: ArtifactRecord;
  readonly value: T;
  readonly intent?: Record<string, unknown> | undefined;
}

export interface DesignServiceInput {
  readonly workflowId?: string;
  readonly readinessPackage: unknown;
  readonly projectProfile?: unknown;
  readonly profile?: unknown;
  readonly rtm?: unknown;
}

export interface AutomationServiceInput {
  readonly workflowId?: string;
  readonly design?: unknown;
  readonly testDesign?: unknown;
  readonly readinessPackage: unknown;
  readonly projectProfile: unknown;
  readonly repositoryInventory?: unknown;
  readonly inventory?: unknown;
}

export interface AutomationReviewServiceInput {
  readonly workflowId?: string;
  readonly [key: string]: unknown;
}

export interface StaticEvidenceSource {
  readonly evidence: readonly ContextEvidence[];
}

/** Read-only source adapter for local fixtures and MCP handoff inputs. */
export function staticEvidenceSource(source: StaticEvidenceSource): RequirementsInvestigatorDependencies['ticket'] {
  const evidence = z.array(ContextEvidenceSchema).parse(source.evidence);
  return { search: async () => evidence.map((item) => structuredClone(item)) };
}

function metadata(value: { traceId: string; revision?: string; role: string }): Record<string, string> {
  return {
    artifactRole: value.role,
    traceId: value.traceId,
    ...(value.revision === undefined ? {} : { revision: value.revision }),
  };
}

function sameArtifact(left: ArtifactRecord, right: ArtifactRecord): boolean {
  return left.traceId === right.traceId && left.kind === right.kind &&
    JSON.stringify(left.content) === JSON.stringify(right.content) &&
    JSON.stringify(left.metadata) === JSON.stringify(right.metadata);
}

async function putIdempotently(store: ArtifactStore, artifact: ArtifactRecord): Promise<ArtifactRecord> {
  const existing = await store.get(artifact.id);
  if (existing !== undefined) {
    if (!sameArtifact(existing, artifact)) throw new Error(`Artifact '${artifact.id}' already contains a different publication.`);
    return existing;
  }
  try {
    await store.put(artifact);
  } catch (error) {
    const winner = await store.get(artifact.id);
    if (winner === undefined || !sameArtifact(winner, artifact)) throw error;
    return winner;
  }
  return artifact;
}

function artifact(value: {
  id: string;
  traceId: string;
  kind: ArtifactRecord['kind'];
  createdAt: string;
  content: unknown;
  metadata: Record<string, string>;
}): ArtifactRecord {
  return ArtifactRecordSchema.parse({ ...value, schemaVersion: '1.0' });
}

function decisionOf(packageValue: ReturnType<typeof validateReadinessPackage>): 'ready' | 'waiting-for-human' {
  const decision = packageValue.proposedReadinessDecision ?? packageValue.readinessDecision;
  return decision === 'ready' || decision === 'ready-for-design' ? 'ready' : 'waiting-for-human';
}

function boundedId(prefix: string, value: string): string {
  const digest = createHash('sha256').update(value).digest('hex').slice(0, 48);
  return `${prefix}:${digest}`;
}

/**
 * Coordinator-facing composition boundary for the evidence-backed story-to-test
 * stages. It only persists validated artifacts and delegates execution to an
 * injected executor; it never shells out, calls a provider, or writes files.
 */
export class StoryToTestWorkflowService {
  readonly coordinator: LifecycleCoordinator;
  readonly #workflows: WorkflowStore;
  readonly #artifacts: ArtifactStore;
  readonly #requirements: RequirementsInvestigatorDependencies | undefined;
  readonly #execute: LocalExecutor | undefined;
  readonly #now: () => string;

  constructor(options: WorkflowServiceOptions) {
    this.#workflows = options.workflows;
    this.#artifacts = options.artifacts;
    this.#requirements = options.requirements ?? options.knowledgeSources;
    this.#execute = options.execute;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.coordinator = new LifecycleCoordinator(options.workflows, this.#now, options.artifacts);
  }

  async investigateRequirements(input: RequirementsServiceInput): Promise<RequirementsServiceResult> {
    if (this.#requirements === undefined) throw new Error('Requirements investigation requires configured read-only sources.');
    const request = RequirementsInvestigationRequestSchema.parse(input);
    const result = await new RequirementsInvestigator(this.#requirements).investigate(request);
    const readinessPackage = validateReadinessPackage(result.readinessPackage);
    const readinessArtifact = artifact({
      id: `readiness-package:${readinessPackage.packageId}`,
      traceId: readinessPackage.traceId,
      kind: 'requirement-analysis',
      createdAt: readinessPackage.createdAt,
      content: readinessPackage,
      metadata: metadata({ traceId: readinessPackage.traceId, revision: readinessPackage.revision, role: 'readiness-package' }),
    });
    const published = await publishReadinessHandoffArtifacts(readinessPackage, this.#artifacts, { now: this.#now });
    const storedReadiness = await putIdempotently(this.#artifacts, readinessArtifact);
    const handoffs: ReadinessHandoffArtifacts = {
      discrepancyReport: published.discrepancyReport,
      traceabilityMatrix: published.traceabilityMatrix,
    };
    const records = [storedReadiness, handoffs.discrepancyReport, handoffs.traceabilityMatrix];
    await this.attach(input.workflowId, readinessPackage.traceId, records);
    const questions = [
      ...readinessPackage.ownedClarifications.map((question) => question.question),
      ...readinessPackage.phaseSpecificBlockers.map((blocker) => blocker.description),
    ];
    return { status: decisionOf(readinessPackage), readinessPackage, artifacts: records, questions };
  }

  async analyzeDiscrepancy(value: unknown, workflowId?: string): Promise<PublishedArtifactResult<DiscrepancyAnalysisReport>> {
    const report = buildDiscrepancyAnalysis(value);
    const traceId = report.traceId;
    if (traceId === undefined) throw new Error('Discrepancy analysis requires a traceId to publish an artifact.');
    const record = artifact({
      id: report.artifact?.id ?? `discrepancy-analysis:${report.storyKey ?? 'story'}:${report.revision}`,
      traceId,
      kind: 'requirement-analysis',
      createdAt: report.generatedAt,
      content: report,
      metadata: metadata({ traceId, revision: report.revision, role: 'discrepancy-analysis' }),
    });
    const stored = await putIdempotently(this.#artifacts, record);
    await this.attach(workflowId, traceId, [stored]);
    return { status: 'ready', artifact: stored, value: report };
  }

  async designTests(input: DesignServiceInput): Promise<PublishedArtifactResult<TestDesign>> {
    const design = buildTestDesign(input);
    const record = artifact({
      id: design.designId,
      traceId: design.traceId,
      kind: 'test-design',
      createdAt: this.#now(),
      content: design,
      metadata: metadata({ traceId: design.traceId, revision: design.revision, role: 'test-design' }),
    });
    const stored = await putIdempotently(this.#artifacts, record);
    await this.attach(input.workflowId, design.traceId, [stored]);
    return { status: design.decision, artifact: stored, value: design };
  }

  async reviewTestDesign(input: { workflowId?: string; readinessPackage: unknown; design: unknown }): Promise<PublishedArtifactResult<TestDesignReview>> {
    const review = reviewTestDesign(input);
    const design = input.design as { designId?: string; traceId?: string; revision?: string };
    const traceId = typeof design.traceId === 'string' ? design.traceId : validateReadinessPackage(input.readinessPackage).traceId;
    const revision = typeof design.revision === 'string' ? design.revision : validateReadinessPackage(input.readinessPackage).revision;
    const record = artifact({
      id: `test-design-review:${typeof design.designId === 'string' ? design.designId : revision}`,
      traceId,
      kind: 'review',
      createdAt: this.#now(),
      content: review,
      metadata: metadata({ traceId, revision, role: 'test-design-review' }),
    });
    const stored = await putIdempotently(this.#artifacts, record);
    await this.attach(input.workflowId, traceId, [stored]);
    return { status: review.verdict === 'approve' ? 'ready' : review.nextStage === 'planning' ? 'waiting-for-human' : 'blocked', artifact: stored, value: review };
  }

  async planAutomation(input: AutomationServiceInput): Promise<PublishedArtifactResult<AutomationPlan>> {
    const plan = new AutomationEngineer().plan(input);
    const traceId = (input.readinessPackage as { traceId?: unknown })?.traceId;
    if (typeof traceId !== 'string') throw new Error('Automation requires a trace-linked readiness package.');
    const record = artifact({
      id: `automation-plan:${plan.designArtifactId}`,
      traceId,
      kind: 'review',
      createdAt: this.#now(),
      content: plan,
      metadata: metadata({ traceId, revision: plan.repositoryRevision, role: 'automation-plan' }),
    });
    const stored = await putIdempotently(this.#artifacts, record);
    await this.attach(input.workflowId, traceId, [stored]);
    return { status: plan.decision, artifact: stored, value: plan, intent: plan.patchIntents[0] as unknown as Record<string, unknown> | undefined };
  }

  async reviewAutomation(input: AutomationReviewServiceInput): Promise<PublishedArtifactResult<AutomationReview>> {
    const review = new AutomationReviewer().review(input);
    const source = input.readinessPackage as { traceId?: unknown } | undefined;
    const traceId = typeof source?.traceId === 'string' ? source.traceId : undefined;
    if (traceId === undefined) throw new Error('Automation review requires a trace-linked readiness package.');
    const record = artifact({
      id: review.reviewId,
      traceId,
      kind: 'review',
      createdAt: this.#now(),
      content: review,
      metadata: metadata({ traceId, revision: review.revision, role: 'automation-review' }),
    });
    const stored = await putIdempotently(this.#artifacts, record);
    await this.attach(input.workflowId, traceId, [stored]);
    return { status: review.verdict === 'approve' ? 'ready' : review.nextStage === 'waiting-for-human' ? 'waiting-for-human' : 'blocked', artifact: stored, value: review };
  }

  async routeVerification(input: VerificationRoutingInput & { workflowId?: string }): Promise<VerificationRoutingResult & { artifact: ArtifactRecord }> {
    if (this.#execute === undefined) throw new Error('Verification requires an injected local executor.');
    const { workflowId: _workflowId, ...request } = input;
    const result = await routeVerification(request, this.#execute, this.#now);
    const record = artifact({
      id: boundedId('verification', result.report.reportId),
      traceId: result.report.traceId,
      kind: 'review',
      createdAt: result.report.generatedAt,
      content: result.report,
      metadata: metadata({ traceId: result.report.traceId, revision: result.report.revision, role: 'verification-report' }),
    });
    const stored = await putIdempotently(this.#artifacts, record);
    await this.attach(input.workflowId, result.report.traceId, [stored]);
    return { ...result, artifact: stored };
  }

  private async attach(workflowId: string | undefined, traceId: string, records: readonly ArtifactRecord[]): Promise<void> {
    if (workflowId === undefined) return;
    const id = WorkflowIdSchema.parse(workflowId);
    const state = await this.coordinator.resume(id);
    if (state.traceId !== traceId) throw new Error(`Workflow '${id}' belongs to another trace.`);
    const artifactIds = [...new Set([...state.artifactIds, ...records.map((record) => {
      if (record.traceId !== traceId) throw new Error(`Artifact '${record.id}' belongs to another trace.`);
      return record.id;
    })])];
    if (artifactIds.length === state.artifactIds.length) return;
    await this.#workflows.save({ ...state, artifactIds }, state.version);
  }
}
