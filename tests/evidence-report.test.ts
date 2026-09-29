import { describe, expect, it } from 'vitest';
import { buildEvidenceReport } from '../src/evidence-report.js';

describe('evidence report', () => {
  it('retains traceability and unresolved blockers without granting release authority', () => {
    const report = buildEvidenceReport({ requirement: 'Eligibility', coverage: ['extend'], review: 'accept', execution: 'success', blockers: ['Missing approval'] });
    expect(report).toMatchObject({ requirement: 'Eligibility', releaseAuthorized: false, blockers: ['Missing approval'] });
  });
});
