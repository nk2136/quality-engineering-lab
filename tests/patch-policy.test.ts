import { describe, expect, it } from 'vitest';
import { validatePatch } from '../src/patch-policy.js';

describe('patch policy', () => {
  it('accepts a bounded test-only diff', () => {
    expect(validatePatch({
      diff: 'diff --git a/tests/eligibility.spec.ts b/tests/eligibility.spec.ts\n+++ b/tests/eligibility.spec.ts\n+expect(page.getByRole("button", { name: "Check eligibility" })).toBeVisible();',
      allowlistedPaths: ['tests/eligibility.spec.ts'],
    })).toEqual({ valid: true, violations: [] });
  });

  it('rejects out-of-scope files, waits, positional locators, and secrets', () => {
    const result = validatePatch({
      diff: 'diff --git a/src/app.ts b/src/app.ts\n+++ b/src/app.ts\n+await page.waitForTimeout(500);\n+page.locator(".item").nth(2);\n+const key = "sk-live-secret";',
      allowlistedPaths: ['tests/eligibility.spec.ts'],
    });
    expect(result.valid).toBe(false);
    expect(result.violations).toEqual(expect.arrayContaining([
      expect.stringContaining('not allowlisted'), expect.stringContaining('arbitrary wait'),
      expect.stringContaining('positional locator'), expect.stringContaining('secret'),
    ]));
  });
});
