import { describe, expect, it } from 'vitest';
import { buildVerificationEvidenceReport, type VerificationEvidenceReport } from '../src/evidence-report.js';
import { ProjectProfileSchema } from '../src/project-profile.js';
import { TestDesignSchema, type TestDesign } from '../src/test-design.js';
import { exportTestManagement, TestManagementExportRequestSchema } from '../src/test-export.js';

const revision = 'a'.repeat(40);
const traceId = '3d594650-3436-4d7c-86a7-2b94788009bc';

function profile(formats: ('json' | 'csv')[] = ['json', 'csv'], destinations: ('local-file' | 'artifact-store')[] = ['local-file']) {
  return ProjectProfileSchema.parse({
    schemaVersion: '1.0', project: { name: 'Eligibility', description: 'Eligibility service checks.' },
    architectureMap: [{ componentId: 'gateway', responsibility: 'Routes eligibility requests.', dependsOn: [] }],
    ticketSystem: { provider: 'jira', baseUrl: 'https://example.atlassian.net', issueKeyPattern: '^[A-Z]+-\\d+$', accessMode: 'read-only' },
    components: [{ id: 'gateway', name: 'Gateway', responsibilities: ['Routes requests.'], repositoryIds: ['app'] }],
    repositories: [{ id: 'app', provider: 'github', repository: 'acme/eligibility', revision, paths: ['src', 'tests'], accessMode: 'read-only' }],
    frameworkConventions: { language: 'typescript', testRunner: 'vitest', testFilePatterns: ['tests/**/*.test.ts'], sourceDirectory: 'src', testDirectory: 'tests', commands: [{ id: 'typecheck', command: 'npm run typecheck', tool: 'npm', readOnly: true }] },
    dataRules: { syntheticDataOnly: true, secretsAllowed: false, forbiddenData: ['production records'], allowedDataSources: ['fixtures'] },
    reportingExport: { formats, destinations }, criticalChecks: [{ id: 'tests', command: 'npm test', tool: 'npm', readOnly: true }],
    hardRules: ['Keep provider access read-only.', 'Never use production data.'],
  });
}

const design: TestDesign = TestDesignSchema.parse({
  schemaVersion: '1.0', artifactKind: 'test-design', designId: 'test-design:QE-42:rev-7', traceId, storyKey: 'QE-42', revision: 'rev-7', component: 'gateway',
  strategy: { style: 'bdd', interactionModel: 'framework-neutral', apiAgnostic: true, conventions: ['Given When Then'] },
  scenarios: [{ id: 'SCENARIO-001', title: 'Authorized users submit a request', category: 'positive', acceptanceCriteriaIds: ['AC-1'], evidenceIds: ['E-1'], setup: ['Create an authorized synthetic user.'], data: ['fixture:user-authorized'], given: ['The user is authorized.'], when: ['The user submits a valid request.'], then: ['A request is created.'], observables: ['The response contains a request identifier.'], cleanup: ['Remove the local fixture.'], assumptions: [] }],
  rtm: [{ id: 'RTM-001', acId: 'AC-1', scenarioIds: ['SCENARIO-001'], evidenceIds: ['E-1'] }], requiredTestData: ['fixture:user-authorized'], outOfScope: [], decision: 'ready', humanDecision: { status: 'not-required', questions: [] }, codeGeneration: false,
});

const execution: VerificationEvidenceReport = buildVerificationEvidenceReport({
  reportId: 'verification:review-1:rev-7:completed', traceId, generatedAt: '2026-10-15T12:00:00.000Z', revision: 'rev-7', reviewId: 'automation-review:QE-42:rev-7', patchHash: 'b'.repeat(64), state: 'completed', classification: null,
  transitions: [{ from: 'verification', to: 'completed', revision: 'rev-7', at: '2026-10-15T12:00:00.000Z', evidenceHash: 'c'.repeat(64) }], requirement: ['AC-1'], sources: ['readiness:QE-42:rev-7'], ui: ['local fixture'], coverage: ['SCENARIO-001'], patch: ['patch:sha256'], review: ['automation-review:QE-42:rev-7'], approval: ['owner:alice'], execution: ['exit-code:0', 'stdout-sha256:digest'], triage: ['success:sha256:digest'], blockers: [], limitations: ['local-only'],
});

const confirmations = {
  ownerConfirmation: { confirmed: true as const, confirmedBy: 'alice', confirmedAt: '2026-10-15T12:01:00.000Z' },
  designerConfirmation: { confirmed: true as const, confirmedBy: 'bob', confirmedAt: '2026-10-15T12:02:00.000Z' },
};

function request(format: 'json' | 'csv' = 'json', overrides: Record<string, unknown> = {}) {
  return { profile: profile(), design, executionEvidence: execution, destinationConfirmation: { destination: 'local-file', format, confirmed: true as const, confirmedBy: 'alice', confirmedAt: '2026-10-15T12:03:00.000Z' }, ...confirmations, ...overrides };
}

describe('test-management export', () => {
  it('emits stable JSON with explicit destination and confirmation metadata', () => {
    const first = exportTestManagement(request());
    expect(first).toEqual(exportTestManagement(request()));
    expect(first.format).toBe('json');
    expect(first.metadata).toMatchObject({ destination: 'local-file', format: 'json', confirmed: true, ownerConfirmed: true, designerConfirmed: true, externalWrite: false });
    expect(first.content).toBe(`${JSON.stringify(JSON.parse(first.content), null, 2)}\n`);
    expect(JSON.parse(first.content)).toMatchObject({ designId: design.designId, executionReportId: execution.reportId, executionState: 'completed' });
  });

  it('emits deterministic CSV rows from design scenarios and observed execution evidence', () => {
    const result = exportTestManagement(request('csv'));
    expect(result.format).toBe('csv');
    expect(result.content).toBe(['storyKey,designId,scenarioId,title,category,acceptanceCriteriaIds,evidenceIds,executionReportId,executionState,executionClassification', 'QE-42,test-design:QE-42:rev-7,SCENARIO-001,Authorized users submit a request,positive,AC-1,E-1,verification:review-1:rev-7:completed,completed,', ''].join('\n'));
  });

  it('requires both confirmations and rejects fabricated execution output', () => {
    expect(() => TestManagementExportRequestSchema.parse(request())).not.toThrow();
    expect(() => exportTestManagement(request('json', { ownerConfirmation: { ...confirmations.ownerConfirmation, confirmed: false } }))).toThrow(/owner/i);
    expect(() => exportTestManagement(request('json', { executionEvidence: { ...execution, execution: [], triage: [] } }))).toThrow(/execution evidence/i);
  });

  it('enforces profile format and destination allowlists', () => {
    expect(() => exportTestManagement({ ...request('csv'), profile: profile(['json']) })).toThrow(/format/i);
    expect(() => exportTestManagement({ ...request(), profile: profile(['json'], ['artifact-store']) })).toThrow(/destination/i);
  });
});
