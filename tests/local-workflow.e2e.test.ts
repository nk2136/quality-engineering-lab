import { describe, expect, it } from 'vitest';
import { MockModelGateway } from '../src/mock-model-gateway.js';
import { runLocalAutomationWorkflow } from '../src/local-workflow.js';

const traceId = '3d594650-3436-4d7c-86a7-2b94788009bc';
const revision = 'a'.repeat(40);
const diff = 'diff --git a/tests/eligibility.spec.ts b/tests/eligibility.spec.ts\n+++ b/tests/eligibility.spec.ts\n+expect(page.getByRole("button", { name: "Check eligibility" })).toBeVisible();';

describe('local automation workflow acceptance', () => {
  it('does not generate a new patch when a pinned existing test already covers the scenario', async () => {
    const result = await runLocalAutomationWorkflow({
      traceId, scenario: { id: 'eligible', text: 'check eligibility', uiEvidence: true },
      files: [{ path: 'tests/eligibility.spec.ts', revision, content: 'test("check eligibility", async () => { await expect(page.getByRole("button", { name: "Check eligibility" })).toBeVisible(); })' }],
      allowlistedPaths: ['tests/eligibility.spec.ts'],
    });
    expect(result).toMatchObject({ decision: 'reuse-existing-test', proposal: null });
  });

  it('creates a policy-clean proposal only for missing coverage and records the awaiting-approval state', async () => {
    const result = await runLocalAutomationWorkflow({
      traceId, scenario: { id: 'eligible', text: 'check eligibility', uiEvidence: true },
      files: [{ path: 'tests/other.spec.ts', revision, content: 'test("other", () => {})' }],
      allowlistedPaths: ['tests/eligibility.spec.ts'],
      gateway: new MockModelGateway([{ task: 'generate-code', output: { diff } }]),
    });
    expect(result).toMatchObject({ decision: 'create-new-test', proposal: { review: { verdict: 'accept' } }, approvalRequired: true });
  });
});
