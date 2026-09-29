import { describe, expect, it } from 'vitest';
import { MockModelGateway } from '../src/mock-model-gateway.js';
import { generatePatchProposal } from '../src/patch-workflow.js';

const traceId = '3d594650-3436-4d7c-86a7-2b94788009bc';
const cleanDiff = 'diff --git a/tests/eligibility.spec.ts b/tests/eligibility.spec.ts\n+++ b/tests/eligibility.spec.ts\n+expect(page.getByRole("button", { name: "Check eligibility" })).toBeVisible();';

describe('bounded patch workflow', () => {
  it('generates a policy-clean proposal from only the approved bounded inputs', async () => {
    const result = await generatePatchProposal({
      traceId,
      requirement: 'Check eligibility',
      coverageDecision: 'create-new-test',
      inventory: 'tests/eligibility.spec.ts',
      uiEvidence: 'button Check eligibility is unique',
      allowlistedPaths: ['tests/eligibility.spec.ts'],
      gateway: new MockModelGateway([{ task: 'generate-code', output: { diff: cleanDiff } }]),
    });

    expect(result).toMatchObject({ diff: cleanDiff, policy: { valid: true }, review: { verdict: 'accept' } });
  });

  it('blocks a rejected patch before it can be approved or executed', async () => {
    const result = await generatePatchProposal({
      traceId,
      requirement: 'Check eligibility',
      coverageDecision: 'create-new-test',
      inventory: 'tests/eligibility.spec.ts',
      uiEvidence: 'button Check eligibility is unique',
      allowlistedPaths: ['tests/eligibility.spec.ts'],
      gateway: new MockModelGateway([{ task: 'generate-code', output: { diff: cleanDiff.replace('getByRole', 'waitForTimeout') } }]),
    });

    expect(result.review.verdict).toBe('block');
  });
});
