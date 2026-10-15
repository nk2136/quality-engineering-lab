import { createHash } from 'node:crypto';
import { z } from 'zod';
import { AutomationReviewSchema, type AutomationReview } from './automation-review.js';
import {
  buildVerificationEvidenceReport,
  VerificationFailureClassificationSchema,
  VerificationStateSchema,
  type VerificationEvidenceReport,
  type VerificationFailureClassification,
  type VerificationState,
} from './evidence-report.js';
import { ExecutionTriageSchema, type ExecutionTriage } from './execution-triage.js';
import type { LocalExecutionResult } from './local-executor.js';

const RequestSchema = z.object({
  traceId: z.string().uuid(),
  revision: z.string().min(1),
  review: AutomationReviewSchema,
  executorInput: z.unknown(),
  requirement: z.array(z.string().min(1)).min(1),
  sources: z.array(z.string().min(1)).min(1),
  ui: z.array(z.string().min(1)).min(1),
  coverage: z.array(z.string().min(1)).min(1),
  patch: z.array(z.string().min(1)).min(1),
  approval: z.array(z.string().min(1)).min(1),
  blockers: z.array(z.string()),
  limitations: z.array(z.string().min(1)).min(1),
});

const ResultSchema = z.object({
  stdout: z.string(),
  stderr: z.string(),
  exitCode: z.number().int().nullable(),
  timedOut: z.boolean(),
  triage: ExecutionTriageSchema,
});

export type VerificationRoutingInput = z.infer<typeof RequestSchema>;
export type LocalExecutor = (input: unknown) => Promise<LocalExecutionResult>;

export interface VerificationRoutingResult {
  readonly state: VerificationState;
  readonly status: VerificationState;
  readonly classification: VerificationFailureClassification | null;
  readonly execution: LocalExecutionResult;
  readonly report: VerificationEvidenceReport;
}

type Clock = () => string;

const hash = (value: string): string => createHash('sha256').update(value).digest('hex');

function failureClassification(triage: ExecutionTriage): VerificationFailureClassification | null {
  if (triage.category === 'success') return null;
  const evidence = triage.evidence.toLowerCase();
  if (/clarif|ambiguous|missing (?:requirement|acceptance|decision)|which .* (?:should|owns|provide)/i.test(evidence)) return 'clarification';
  if (triage.category === 'timeout' || triage.category === 'infrastructure-failure') return 'environment';
  if (triage.category === 'compilation-failure') return 'test';
  if (/locator|selector|fixture|mock|test (?:code|bug)|no tests? found|assertion in test/i.test(evidence)) return 'test';
  return 'product';
}

function targetState(classification: VerificationFailureClassification | null): VerificationState {
  if (classification === null) return 'completed';
  if (classification === 'clarification') return 'waiting-for-human';
  if (classification === 'environment') return 'blocked';
  return 'failed';
}

function failedExecution(error: unknown): LocalExecutionResult {
  const evidence = error instanceof Error ? error.message : String(error);
  return {
    stdout: '',
    stderr: '',
    exitCode: null,
    timedOut: false,
    triage: { category: 'infrastructure-failure', evidence },
  };
}

function commandEvidence(value: unknown): string {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return 'command:unavailable';
  const command = (value as { command?: unknown }).command;
  return Array.isArray(command) && command.every((item) => typeof item === 'string')
    ? `command-sha256:${hash(JSON.stringify(command))}`
    : 'command:unavailable';
}

/** Routes an approved review through the supplied local-executor boundary only. */
export async function routeVerification(
  value: unknown,
  execute: LocalExecutor,
  now: Clock = () => new Date().toISOString(),
): Promise<VerificationRoutingResult> {
  const input = RequestSchema.parse(value);
  if (input.review.verdict !== 'approve') throw new Error('Verification requires an approved automation review.');
  if (input.review.revision !== input.revision) throw new Error('Verification review revision does not match the requested revision.');

  let execution: LocalExecutionResult;
  try {
    execution = ResultSchema.parse(await execute(input.executorInput));
  } catch (error) {
    execution = failedExecution(error);
  }

  const classification = failureClassification(execution.triage);
  const state = VerificationStateSchema.parse(targetState(classification));
  const generatedAt = now();
  const evidenceHash = hash([
    input.revision,
    execution.triage.category,
    execution.triage.evidence,
    execution.stdout,
    execution.stderr,
  ].join('\n'));
  const review = input.review;
  const report = buildVerificationEvidenceReport({
    reportId: `verification:${review.reviewId}:${input.revision}:${state}`,
    traceId: input.traceId,
    generatedAt,
    revision: input.revision,
    reviewId: review.reviewId,
    patchHash: review.patchHash,
    state,
    classification,
    transitions: [{ from: 'verification', to: state, revision: input.revision, at: generatedAt, evidenceHash }],
    requirement: input.requirement,
    sources: input.sources,
    ui: input.ui,
    coverage: input.coverage,
    patch: [...input.patch, `sha256:${review.patchHash}`],
    review: [review.reviewId, ...review.artifactIds],
    approval: input.approval,
    execution: [
      commandEvidence(input.executorInput),
      `exit-code:${execution.exitCode === null ? 'null' : execution.exitCode}`,
      `timed-out:${execution.timedOut}`,
      `stdout-sha256:${hash(execution.stdout)}`,
      `stderr-sha256:${hash(execution.stderr)}`,
    ],
    triage: [`${execution.triage.category}:sha256:${hash(execution.triage.evidence)}`],
    blockers: classification === null ? input.blockers : [...input.blockers, `Verification classified as ${classification}.`],
    limitations: input.limitations,
  });

  return { state, status: state, classification, execution, report };
}

export class VerificationRouter {
  constructor(private readonly execute: LocalExecutor, private readonly now: Clock = () => new Date().toISOString()) {}

  route(value: unknown): Promise<VerificationRoutingResult> {
    return routeVerification(value, this.execute, this.now);
  }
}
