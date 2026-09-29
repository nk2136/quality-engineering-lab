import { z } from 'zod';
import type { ModelGateway } from './contracts.js';
import { buildCoverageMatrix } from './coverage-matrix.js';
import { generatePatchProposal, type PatchProposal } from './patch-workflow.js';

const FileSchema = z.object({ path: z.string().min(1), revision: z.string().regex(/^[0-9a-f]{40}$/), content: z.string() });
const InputSchema = z.object({
  traceId: z.string().uuid(),
  scenario: z.object({ id: z.string().min(1), text: z.string().min(1), uiEvidence: z.boolean() }),
  files: z.array(FileSchema).min(1),
  allowlistedPaths: z.array(z.string().min(1)).min(1),
  gateway: z.custom<ModelGateway>().optional(),
});

export async function runLocalAutomationWorkflow(value: unknown): Promise<{
  readonly decision: string;
  readonly proposal: PatchProposal | null;
  readonly approvalRequired: boolean;
}> {
  const input = InputSchema.parse(value);
  const [coverage] = buildCoverageMatrix({ files: input.files, scenarios: [input.scenario] });
  if (coverage!.decision !== 'create-new-test') return { decision: coverage!.decision, proposal: null, approvalRequired: false };
  if (input.gateway === undefined) throw new Error('A model gateway is required to propose missing coverage.');
  const proposal = await generatePatchProposal({
    traceId: input.traceId,
    requirement: input.scenario.text,
    coverageDecision: coverage!.decision,
    inventory: input.files.map(({ path }) => path).join('\n'),
    uiEvidence: 'UI locator evidence is available for this scenario.',
    allowlistedPaths: input.allowlistedPaths,
    gateway: input.gateway,
  });
  return { decision: coverage!.decision, proposal, approvalRequired: proposal.review.verdict === 'accept' };
}
