import { z } from 'zod';
import type { ModelGateway } from './contracts.js';
import { validatePatch, type PatchPolicyResult } from './patch-policy.js';
import { reviewPatch, type PatchReview } from './patch-review.js';

const ModelOutputSchema = z.object({ diff: z.string().min(1).max(100_000) });
const InputSchema = z.object({
  traceId: z.string().uuid(),
  requirement: z.string().min(1),
  coverageDecision: z.literal('create-new-test'),
  inventory: z.string().min(1),
  uiEvidence: z.string().min(1),
  allowlistedPaths: z.array(z.string().min(1)).min(1),
  gateway: z.custom<ModelGateway>(),
});

export interface PatchProposal {
  readonly diff: string;
  readonly policy: PatchPolicyResult;
  readonly review: PatchReview;
}

/** Generates a patch from the complete, allowlisted input set; it never approves or runs it. */
export async function generatePatchProposal(value: unknown): Promise<PatchProposal> {
  const input = InputSchema.parse(value);
  const response = await input.gateway.generate({
    traceId: input.traceId,
    task: 'generate-code',
    promptVersion: 'patch-v1',
    input: JSON.stringify({
      requirement: input.requirement,
      coverageDecision: input.coverageDecision,
      inventory: input.inventory,
      uiEvidence: input.uiEvidence,
      allowlistedPaths: input.allowlistedPaths,
    }),
    maxOutputTokens: 4_096,
  }, {} as never);
  const { diff } = ModelOutputSchema.parse(response.output);
  const policy = validatePatch({ diff, allowlistedPaths: input.allowlistedPaths });
  return { diff, policy, review: reviewPatch(policy) };
}
