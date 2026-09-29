import { z } from 'zod';

const InputSchema = z.object({ requirement: z.string().min(1), coverage: z.array(z.string()), review: z.string(), execution: z.string(), blockers: z.array(z.string()) });
export const EvidenceReportSchema = InputSchema.extend({ releaseAuthorized: z.literal(false) });
export type EvidenceReport = z.infer<typeof EvidenceReportSchema>;

export function buildEvidenceReport(value: unknown): EvidenceReport {
  const input = InputSchema.parse(value);
  return { ...input, releaseAuthorized: false };
}
