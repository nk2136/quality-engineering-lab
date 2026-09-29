import { describe, expect, it } from 'vitest';
import { buildEvidenceReport, buildWorkflowEvidenceReport } from '../src/evidence-report.js';

describe('evidence report', () => {
  it('retains traceability and unresolved blockers without granting release authority', () => {
    const report = buildEvidenceReport({ requirement: 'Eligibility', coverage: ['extend'], review: 'accept', execution: 'success', blockers: ['Missing approval'] });
    expect(report).toMatchObject({ requirement: 'Eligibility', releaseAuthorized: false, blockers: ['Missing approval'] });
  });

  it('links every workflow handoff and limitation without authorizing release', () => {
    const report = buildWorkflowEvidenceReport({
      traceId: '3d594650-3436-4d7c-86a7-2b94788009bc', generatedAt: '2026-09-29T12:00:00.000Z',
      requirement: ['AC-1: eligibility result'], sources: ['revision: abc123'],
      ui: ['unique role locator'], coverage: ['create new test'], patch: ['policy clean'],
      review: ['accept'], approval: ['sha256 bound'], execution: ['npm test: success'],
      triage: ['success'], blockers: [], limitations: ['mock data only'],
    });
    expect(report).toMatchObject({ traceId: '3d594650-3436-4d7c-86a7-2b94788009bc', limitations: ['mock data only'], releaseAuthorized: false });
  });
});
