import { describe, expect, it } from 'vitest';
import { RepositoryCoverageAdvisor } from '../src/repository-inventory.js';

const revision = 'a'.repeat(40);
const files = [
  { path: 'tests/eligibility.spec.ts', revision, content: "test('checks member eligibility', async () => { await page.waitForTimeout(500); await expect(page.getByRole('heading', { name: 'Eligibility' })).toBeVisible(); })" },
  { path: 'src/pages/EligibilityPage.ts', revision, content: 'export class EligibilityPage {}' },
  { path: 'tests/fixtures/member.ts', revision, content: 'export const member = { id: "MEMBER-42" };' },
];

describe('RepositoryCoverageAdvisor', () => {
  it('reuses evidence-backed existing coverage instead of proposing a duplicate test', () => {
    const result = new RepositoryCoverageAdvisor().advise({ requirement: 'checks member eligibility', files });

    expect(result.decision).toBe('reuse-existing-test');
    expect(result.targetPath).toBe('tests/eligibility.spec.ts');
    expect(result.inventory).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'tests/eligibility.spec.ts', kind: 'test' }),
      expect.objectContaining({ path: 'src/pages/EligibilityPage.ts', kind: 'page-object' }),
      expect.objectContaining({ path: 'tests/fixtures/member.ts', kind: 'fixture' }),
    ]));
    expect(result.warnings).toContain('tests/eligibility.spec.ts uses an arbitrary wait.');
  });

  it('extends the closest existing suite when coverage is related but incomplete', () => {
    const result = new RepositoryCoverageAdvisor().advise({ requirement: 'checks member eligibility warning', files });

    expect(result).toMatchObject({ decision: 'extend-existing-test', targetPath: 'tests/eligibility.spec.ts' });
  });

  it('stops rather than inventing a placement when no repository evidence matches', () => {
    const result = new RepositoryCoverageAdvisor().advise({ requirement: 'approve payroll export', files });

    expect(result).toMatchObject({ decision: 'insufficient-evidence', targetPath: null });
  });

  it('does not treat a test title or filename as proof of exercised coverage', () => {
    const result = new RepositoryCoverageAdvisor().advise({
      requirement: 'checks member eligibility',
      files: [{ path: 'tests/eligibility.spec.ts', revision, content: "test('checks member eligibility', async () => {})" }],
    });

    expect(result).toMatchObject({ decision: 'insufficient-evidence', targetPath: null });
    expect(result.blockers).toContain('The highest-overlap test has no observable assertion or interaction evidence.');
  });
});
