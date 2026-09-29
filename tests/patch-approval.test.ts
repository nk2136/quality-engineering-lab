import { describe, expect, it } from 'vitest';
import { approvePatch, isApprovalCurrent } from '../src/patch-approval.js';

const inputs = { requirement: 'a', evidence: 'b', revision: 'c', ui: 'd', coverage: 'e', patch: 'f', policy: 'g' };

describe('patch approval', () => {
  it('binds a named reviewer to every input hash and invalidates changed inputs', () => {
    const approval = approvePatch({ reviewer: 'Nikesh', approvedAt: '2026-09-29T12:00:00.000Z', inputs });
    expect(isApprovalCurrent(approval, inputs)).toBe(true);
    expect(isApprovalCurrent(approval, { ...inputs, patch: 'changed' })).toBe(false);
  });
});
