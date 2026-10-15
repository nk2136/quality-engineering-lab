import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ContextEvidence } from '../../src/context.js';
import type { KnowledgeQuery, KnowledgeSource } from '../../src/contracts.js';
import { RequirementsInvestigator } from '../../src/requirements-investigator.js';
import { buildTestDesign } from '../../src/test-design.js';
import { reviewTestDesign } from '../../src/test-design-review.js';
import { AutomationEngineer } from '../../src/automation-engineer.js';
import { reviewAutomationPatch } from '../../src/automation-review.js';
import { approvePatch } from '../../src/patch-approval.js';
import { executeApprovedPatch } from '../../src/local-executor.js';
import { buildWorkflowEvidenceReport } from '../../src/evidence-report.js';

const traceId = '3d594650-3436-4d7c-86a7-2b94788009bc';
const revision = 'a'.repeat(40);
const asOf = '2026-10-15T18:05:00.000Z';
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

class FixtureSource implements KnowledgeSource {
  constructor(private readonly evidence: readonly ContextEvidence[]) {}
  async search(_query: KnowledgeQuery): Promise<readonly ContextEvidence[]> { return this.evidence; }
}

function evidence(id: string, source: ContextEvidence['source'], content: string, itemRevision = revision): ContextEvidence {
  return { id, source, uri: `mock://${id}`, revision: itemRevision, retrievedAt: asOf, content, estimatedTokens: 10, relevance: 1 };
}

describe('story-to-test acceptance flow', () => {
  it('moves a local assignment through refinement, Phase A/B gates, verification, and evidence', async () => {
    const investigator = new RequirementsInvestigator({
      ticket: new FixtureSource([evidence('jira-QE-42', 'jira', JSON.stringify({ key: 'QE-42', summary: 'Reject inactive members', acceptanceCriteria: ['Inactive members receive a rejection.'], component: 'membership-service' }), 'jira-rev-7')]),
      history: new FixtureSource([evidence('history-QE-41', 'jira', JSON.stringify({ summary: 'The rejection contract is shared by the continuation story.' }), 'jira-rev-6')]),
      source: new FixtureSource([evidence('github-membership', 'github', JSON.stringify({ component: 'membership-service', branch: 'main', revision, files: ['src/membership.ts'] }))]),
      tests: new FixtureSource([evidence('test-membership', 'test', JSON.stringify({ path: 'tests/membership.spec.ts', covers: ['Inactive members receive a rejection.'] }))]),
    });
    const readiness = (await investigator.investigate({ traceId, storyKey: 'QE-42', sourceRevision: revision, asOf })).readinessPackage;
    expect(readiness.readinessDecision).toBe('ready'); // Phase A: evidence and refinement gate.

    const profile = {
      frameworkConventions: { testRunner: 'vitest', testFilePatterns: ['tests/**/*.test.ts'], testDirectory: 'tests' },
      testConventions: ['BDD Given When Then; framework-neutral interactions.'],
      dataRules: { syntheticDataOnly: true, secretsAllowed: false, allowedDataSources: ['fixtures', 'mocks', 'local-artifacts'] },
    };
    const design = buildTestDesign({ readinessPackage: readiness, projectProfile: profile });
    const designReview = reviewTestDesign({ readinessPackage: readiness, design });
    expect(designReview.verdict).toBe('approve');

    const plan = new AutomationEngineer().plan({
      design, readinessPackage: readiness, projectProfile: profile,
      repositoryInventory: [{ path: 'tests/membership.test.ts', revision, kind: 'test' }],
    });
    const intent = plan.patchIntents[0]!;
    const diff = [
      'diff --git a/tests/membership.test.ts b/tests/membership.test.ts',
      '--- a/tests/membership.test.ts',
      '+++ b/tests/membership.test.ts',
      '@@ -1 +1,3 @@',
      '-export const existing = false;',
      '+export const existing = false;',
      '+// QE-42: bounded synthetic acceptance coverage',
      '+export const qe42 = true;',
    ].join('\n') + '\n';
    const automationReview = reviewAutomationPatch({
      diff, revision, allowlistedPaths: [intent.targetPath], patchIntent: intent,
      design, readinessPackage: readiness, projectProfile: profile,
    });
    expect(automationReview.verdict).toBe('approve'); // Phase B: design, patch, and independent review gate.

    const sourceDirectory = await mkdtemp(join(tmpdir(), 'qe-story-acceptance-'));
    roots.push(sourceDirectory);
    await mkdir(join(sourceDirectory, 'tests'), { recursive: true });
    await writeFile(join(sourceDirectory, 'tests/membership.test.ts'), 'export const existing = false;\n');
    const inputs = { requirement: readiness.packageId, evidence: 'jira-QE-42;github-membership', revision, ui: 'not-required', coverage: design.designId, patch: diff, policy: automationReview.reviewId };
    const execution = await executeApprovedPatch({
      approval: approvePatch({ reviewer: 'local-acceptance-reviewer', approvedAt: asOf, inputs }),
      inputs, sourceDirectory, command: [process.execPath, '-e', 'process.stdout.write("verification passed")'],
      environment: { QE_MODE: 'local-mock' }, review: { verdict: 'accept', findings: [] }, timeoutMs: 5_000,
    });
    expect(execution.triage.category).toBe('success');

    const report = buildWorkflowEvidenceReport({
      traceId, generatedAt: asOf,
      requirement: readiness.acceptanceCriteria.map((criterion: { id: string; statement: string }) => `${criterion.id}: ${criterion.statement}`),
      sources: readiness.provenance.sources.map((source: { id: string; revision: string }) => `${source.id}@${source.revision}`),
      ui: ['not-required for this API-agnostic local fixture'], coverage: [intent.targetPath],
      patch: [automationReview.patchHash], review: [automationReview.reviewId],
      approval: ['local-acceptance-reviewer'], execution: ['local mock command'],
      triage: [execution.triage.category], blockers: [], limitations: ['mock providers; no live Jira or GitHub access'],
    });
    expect(report.releaseAuthorized).toBe(false);
    expect(report.blockers).toEqual([]);
  });
});
