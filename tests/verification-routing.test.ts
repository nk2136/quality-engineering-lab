import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { approvePatch } from '../src/patch-approval.js';
import { routeVerification } from '../src/verification-routing.js';

const traceId = '3d594650-3436-4d7c-86a7-2b94788009bc';
const revision = 'rev-7';
const inputs = { requirement: 'r', evidence: 'e', revision, ui: 'u', coverage: 'c', patch: 'p', policy: 'policy' };
const review = {
  schemaVersion: '1.0' as const,
  artifactKind: 'automation-review' as const,
  reviewId: 'automation-review:STORY-42:rev-7',
  verdict: 'approve' as const,
  nextStage: 'implementation' as const,
  findings: [],
  patchHash: createHash('sha256').update('patch').digest('hex'),
  revision,
  artifactIds: ['readiness:STORY-42:rev-7', 'design:STORY-42:rev-7'],
  reviewSummary: 'Bounded and traceable.',
};

const request = {
  traceId,
  revision,
  review,
  executorInput: { approval: approvePatch({ reviewer: 'reviewer', approvedAt: '2026-10-15T12:00:00.000Z', inputs }) },
  requirement: ['AC-1'],
  sources: ['readiness:STORY-42:rev-7'],
  ui: ['role=button'],
  coverage: ['SCENARIO-001'],
  patch: ['patch:sha256'],
  approval: ['reviewer:reviewer'],
  blockers: [],
  limitations: ['local fixture only'],
};

function execution(category: 'success' | 'assertion-failure' | 'infrastructure-failure' | 'compilation-failure' | 'timeout', evidence = '') {
  return { stdout: '', stderr: '', exitCode: category === 'success' ? 0 : 1, timedOut: category === 'timeout', triage: { category, evidence } };
}

describe('verification routing', () => {
  it('runs approved automation only through the injected executor and completes on success', async () => {
    const executor = vi.fn().mockResolvedValue(execution('success'));

    const result = await routeVerification(request, executor, () => '2026-10-15T12:01:00.000Z');

    expect(executor).toHaveBeenCalledWith(request.executorInput);
    expect(result.state).toBe('completed');
    expect(result.classification).toBeNull();
    expect(result.report).toMatchObject({
      revision,
      state: 'completed',
      releaseAuthorized: false,
      transitions: [{ from: 'verification', to: 'completed', revision }],
    });
  });

  it.each([
    ['product', 'AssertionError: expected eligibility rejection', 'failed'],
    ['test', 'locator was not found in the test fixture', 'failed'],
    ['environment', 'ECONNREFUSED local service', 'blocked'],
    ['clarification', 'clarification required: which account owns this data?', 'waiting-for-human'],
  ] as const)('routes %s failures without exposing raw logs', async (classification, evidence, state) => {
    const result = await routeVerification({ ...request, executorInput: { secret: 'do-not-report' } }, async () => execution(classification === 'product' ? 'assertion-failure' : classification === 'test' ? 'assertion-failure' : classification === 'environment' ? 'infrastructure-failure' : 'compilation-failure', evidence), () => '2026-10-15T12:01:00.000Z');

    expect(result.state).toBe(state);
    expect(result.classification).toBe(classification);
    expect(result.report).toMatchObject({ revision, state, classification, releaseAuthorized: false });
    expect(JSON.stringify(result.report)).not.toContain('do-not-report');
    expect(JSON.stringify(result.report)).not.toContain(evidence);
  });

  it('rejects a non-approved or stale review before invoking the executor', async () => {
    const executor = vi.fn().mockResolvedValue(execution('success'));

    await expect(routeVerification({ ...request, review: { ...review, verdict: 'reject' } }, executor)).rejects.toThrow('approved');
    await expect(routeVerification({ ...request, revision: 'rev-8' }, executor)).rejects.toThrow('revision');
    expect(executor).not.toHaveBeenCalled();
  });
});
