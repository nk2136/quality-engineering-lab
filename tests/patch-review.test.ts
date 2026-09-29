import { describe, expect, it } from 'vitest';
import { reviewPatch } from '../src/patch-review.js';

describe('patch review', () => {
  it('accepts a policy-clean patch and blocks a policy violation', () => {
    expect(reviewPatch({ valid: true, violations: [] })).toEqual({ verdict: 'accept', findings: [] });
    expect(reviewPatch({ valid: false, violations: ['Patch contains an arbitrary wait.'] })).toEqual({
      verdict: 'block', findings: ['Patch contains an arbitrary wait.'],
    });
  });
});
