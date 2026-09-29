import { describe, expect, it } from 'vitest';
import { buildCoverageMatrix } from '../src/coverage-matrix.js';

const revision = 'a'.repeat(40);
const files = [
  { path: 'tests/eligibility.spec.ts', revision, content: "test('checks member eligibility', async () => {})" },
  { path: 'src/pages/EligibilityPage.ts', revision, content: 'export class EligibilityPage {}' },
];

describe('coverage matrix', () => {
  it('uses repository evidence to distinguish reuse, extension, creation, and blockers', () => {
    const matrix = buildCoverageMatrix({
      files,
      scenarios: [
        { id: 'existing', text: 'checks member eligibility', uiEvidence: true },
        { id: 'extend', text: 'checks member eligibility warning', uiEvidence: true },
        { id: 'new', text: 'enroll dependent household', uiEvidence: true },
        { id: 'blocked', text: 'approve payroll export', uiEvidence: false },
      ],
    });

    expect(matrix).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'existing', decision: 'reuse-existing-test', targetPath: 'tests/eligibility.spec.ts' }),
      expect.objectContaining({ id: 'extend', decision: 'extend-existing-test', targetPath: 'tests/eligibility.spec.ts' }),
      expect.objectContaining({ id: 'new', decision: 'create-new-test', targetPath: 'tests/enroll-dependent-household.spec.ts' }),
      expect.objectContaining({ id: 'blocked', decision: 'insufficient-evidence', targetPath: null }),
    ]));
  });
});
