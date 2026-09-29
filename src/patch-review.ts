import { z } from 'zod';

const InputSchema = z.object({ valid: z.boolean(), violations: z.array(z.string()) });
export const PatchReviewSchema = z.object({ verdict: z.enum(['accept', 'revise', 'block']), findings: z.array(z.string()) });
export type PatchReview = z.infer<typeof PatchReviewSchema>;

export function reviewPatch(value: unknown): PatchReview {
  const policy = InputSchema.parse(value);
  return policy.valid
    ? { verdict: 'accept', findings: [] }
    : { verdict: 'block', findings: policy.violations };
}
