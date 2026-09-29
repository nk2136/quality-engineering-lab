import { z } from 'zod';

const InputSchema = z.object({ requirement: z.string().min(1), coverage: z.array(z.string()), review: z.string(), execution: z.string(), blockers: z.array(z.string()) });
export const EvidenceReportSchema = InputSchema.extend({ releaseAuthorized: z.literal(false) });
export type EvidenceReport = z.infer<typeof EvidenceReportSchema>;

export function buildEvidenceReport(value: unknown): EvidenceReport {
  const input = InputSchema.parse(value);
  return { ...input, releaseAuthorized: false };
}

const WorkflowInputSchema = z.object({
  traceId: z.string().uuid(),
  generatedAt: z.string().datetime(),
  requirement: z.array(z.string().min(1)),
  sources: z.array(z.string().min(1)),
  ui: z.array(z.string().min(1)),
  coverage: z.array(z.string().min(1)),
  patch: z.array(z.string().min(1)),
  review: z.array(z.string().min(1)),
  approval: z.array(z.string().min(1)),
  execution: z.array(z.string().min(1)),
  triage: z.array(z.string().min(1)),
  blockers: z.array(z.string()),
  limitations: z.array(z.string().min(1)),
});

export const WorkflowEvidenceReportSchema = WorkflowInputSchema.extend({ releaseAuthorized: z.literal(false) });
export type WorkflowEvidenceReport = z.infer<typeof WorkflowEvidenceReportSchema>;

/** Produces a read-only handoff manifest; release authority is intentionally absent. */
export function buildWorkflowEvidenceReport(value: unknown): WorkflowEvidenceReport {
  return { ...WorkflowInputSchema.parse(value), releaseAuthorized: false };
}
