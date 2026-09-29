import { createHash } from 'node:crypto';
import { z } from 'zod';

const InputsSchema = z.object({ requirement: z.string(), evidence: z.string(), revision: z.string(), ui: z.string(), coverage: z.string(), patch: z.string(), policy: z.string() });
const RequestSchema = z.object({ reviewer: z.string().min(1), approvedAt: z.string().datetime(), inputs: InputsSchema });
export const PatchApprovalSchema = z.object({ reviewer: z.string(), approvedAt: z.string(), hashes: z.record(z.string(), z.string().length(64)) });
export type PatchApproval = z.infer<typeof PatchApprovalSchema>;

function hashes(inputs: z.infer<typeof InputsSchema>): Record<string, string> {
  return Object.fromEntries(Object.entries(inputs).map(([key, value]) => [key, createHash('sha256').update(value).digest('hex')]));
}

export function approvePatch(value: unknown): PatchApproval {
  const request = RequestSchema.parse(value);
  return { reviewer: request.reviewer, approvedAt: request.approvedAt, hashes: hashes(request.inputs) };
}

export function isApprovalCurrent(approvalValue: unknown, inputsValue: unknown): boolean {
  const approval = PatchApprovalSchema.parse(approvalValue);
  const current = hashes(InputsSchema.parse(inputsValue));
  return Object.keys(current).every((key) => approval.hashes[key] === current[key]);
}
