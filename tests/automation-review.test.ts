import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  AutomationReviewSchema,
  reviewAutomationPatch,
} from '../src/automation-review.js';

const diff = [
  'diff --git a/tests/request.spec.ts b/tests/request.spec.ts',
  '--- a/tests/request.spec.ts',
  '+++ b/tests/request.spec.ts',
  '@@ -1,1 +1,8 @@',
  '+import { test, expect } from "vitest";',
  '+test("submits a request", async () => {',
  '+  expect(true).toBe(true);',
  '+});',
].join('\n');

const input = {
  diff,
  revision: 'rev-7',
  allowlistedPaths: ['tests/request.spec.ts'],
  patchIntent: {
    designId: 'design:QE-42:rev-7',
    readinessPackageId: 'readiness:QE-42:rev-7',
    acceptanceCriteriaIds: ['AC-1'],
    scenarioIds: ['SCENARIO-001'],
  },
  design: {
    designId: 'design:QE-42:rev-7',
    revision: 'rev-7',
    scenarios: [{ id: 'SCENARIO-001', acceptanceCriteriaIds: ['AC-1'] }],
  },
  frameworkConventions: {
    testRunner: 'vitest',
    testFilePatterns: ['tests/**/*.spec.ts'],
  },
};

describe('automation review', () => {
  it('approves a bounded traceable patch and binds the result to its hash and revision', () => {
    const result = reviewAutomationPatch(input);

    expect(AutomationReviewSchema.parse(result)).toEqual(result);
    expect(result.verdict).toBe('approve');
    expect(result.nextStage).toBe('implementation');
    expect(result.patchHash).toBe(createHash('sha256').update(diff).digest('hex'));
    expect(result.revision).toBe('rev-7');
    expect(result.artifactIds).toEqual([
      'readiness:QE-42:rev-7',
      'design:QE-42:rev-7',
    ]);
    expect(result.findings).toEqual([]);
  });

  it('rejects untraceable, out-of-scope, unsafe, and over-bounded patches', () => {
    const result = reviewAutomationPatch({
      ...input,
      diff: [
        'diff --git a/src/app.ts b/src/app.ts',
        '--- a/src/app.ts',
        '+++ b/src/app.ts',
        '@@ -1,1 +1,12 @@',
        '+const token = "sk-live-secret";',
        '+exec("rm -rf ./tmp");',
        '+test.only("wrong runner", () => {});',
        ...Array.from({ length: 8 }, (_, index) => `+const line${index} = ${index};`),
      ].join('\n'),
      patchIntent: {
        ...input.patchIntent,
        acceptanceCriteriaIds: ['AC-MISSING'],
        scenarioIds: ['SCENARIO-MISSING'],
      },
      design: {
        ...input.design,
        scenarios: [],
      },
      maxChangedLines: 5,
    });

    expect(result.verdict).toBe('reject');
    expect(result.nextStage).toBe('implementation');
    expect(result.findings.map((finding) => finding.category)).toEqual(expect.arrayContaining([
      'traceability', 'paths', 'credentials', 'destructive', 'framework', 'bounds',
    ]));
    expect(result.findings.every((finding) => finding.severity === 'blocking')).toBe(true);
  });

  it('routes a patch with an unresolved human decision to waiting-for-human', () => {
    const result = reviewAutomationPatch({
      ...input,
      patchIntent: { ...input.patchIntent, humanDecision: 'confirm test data owner' },
    });

    expect(result.verdict).toBe('reject');
    expect(result.nextStage).toBe('waiting-for-human');
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ category: 'human-decision', severity: 'warning' }),
    ]));
  });
});
