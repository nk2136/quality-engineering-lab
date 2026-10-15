import { describe, expect, it } from 'vitest';
import { AutomationEngineer, AutomationPatchIntentSchema } from '../src/automation-engineer.js';

const revision = 'a'.repeat(40);
const readinessPackage = {
  packageId: 'readiness:QE-42:rev-7',
  traceId: '3d594650-3436-4d7c-86a7-2b94788009bc',
};

const design = {
  schemaVersion: '1.0' as const,
  artifactKind: 'test-design' as const,
  designId: 'test-design:QE-42:rev-7',
  traceId: readinessPackage.traceId,
  storyKey: 'QE-42',
  revision: 'rev-7',
  component: 'request-api',
  strategy: {
    style: 'bdd' as const,
    interactionModel: 'page-object' as const,
    apiAgnostic: true as const,
    conventions: ['Use Playwright page objects.', 'Keep tests in tests/**/*.spec.ts.'],
  },
  scenarios: [{
    id: 'SCENARIO-001',
    title: 'Authorized users submit a request',
    category: 'positive' as const,
    acceptanceCriteriaIds: ['AC-1'],
    evidenceIds: ['jira-QE-42'],
    setup: ['Use the request page object.'],
    data: ['Use a synthetic request payload.'],
    given: ['Given an authorized synthetic user exists.'],
    when: ['When the user submits a request.'],
    then: ['Then a request identifier is returned.'],
    observables: ['request identifier'],
    cleanup: ['Delete the synthetic request.'],
    assumptions: [],
  }],
  rtm: [{ id: 'RTM-001', acId: 'AC-1', scenarioIds: ['SCENARIO-001'], evidenceIds: ['jira-QE-42'] }],
  requiredTestData: ['synthetic request payload'],
  outOfScope: [],
  decision: 'ready' as const,
  humanDecision: { status: 'not-required' as const, questions: [] },
  codeGeneration: false as const,
};

const profile = {
  frameworkConventions: {
    language: 'typescript',
    testRunner: 'playwright',
    testFilePatterns: ['tests/**/*.spec.ts'],
    sourceDirectory: 'src',
    testDirectory: 'tests',
  },
  dataRules: {
    syntheticDataOnly: true,
    secretsAllowed: false,
    allowedDataSources: ['fixtures', 'mocks', 'local-artifacts'],
  },
  hardRules: ['Use page objects for UI interactions.'],
};

const inventory = [
  { path: 'tests/request.spec.ts', revision, kind: 'test' as const },
  { path: 'tests/pages/RequestPage.ts', revision, kind: 'page-object' as const },
  { path: 'tests/fixtures/request.ts', revision, kind: 'fixture' as const },
];

describe('AutomationEngineer', () => {
  it('returns a bounded, traceable intent that reuses repository conventions', () => {
    const result = new AutomationEngineer().plan({
      design,
      readinessPackage,
      projectProfile: profile,
      repositoryInventory: inventory,
    });

    expect(result.decision).toBe('ready');
    expect(result.patchIntents).toHaveLength(1);
    expect(AutomationPatchIntentSchema.parse(result.patchIntents[0])).toEqual(result.patchIntents[0]);
    expect(result.patchIntents[0]).toMatchObject({
      action: 'extend',
      targetPath: 'tests/request.spec.ts',
      framework: 'playwright',
      designArtifactId: design.designId,
      readinessPackageId: readinessPackage.packageId,
      repositoryRevision: revision,
      syntheticDataOnly: true,
      scenarioIds: ['SCENARIO-001'],
      acceptanceCriteriaIds: ['AC-1'],
    });
    expect(result.patchIntents[0]?.artifactLinks).toEqual(expect.arrayContaining([
      design.designId,
      readinessPackage.packageId,
      'jira-QE-42',
    ]));
  });

  it('stops when the design is not accepted or the readiness package is not linked', () => {
    expect(() => new AutomationEngineer().plan({
      design: { ...design, decision: 'waiting-for-human' },
      readinessPackage,
      projectProfile: profile,
      repositoryInventory: inventory,
    })).toThrow(/ready/i);

    expect(() => new AutomationEngineer().plan({
      design,
      readinessPackage: { traceId: readinessPackage.traceId },
      projectProfile: profile,
      repositoryInventory: inventory,
    })).toThrow(/packageId/i);
  });

  it('rejects unsupported framework conventions, non-test paths, and non-synthetic data', () => {
    expect(() => new AutomationEngineer().plan({
      design,
      readinessPackage,
      projectProfile: { ...profile, frameworkConventions: { ...profile.frameworkConventions, testRunner: 'jest' } },
      repositoryInventory: inventory,
    })).toThrow(/framework|runner/i);

    expect(() => new AutomationEngineer().plan({
      design,
      readinessPackage,
      projectProfile: { ...profile, dataRules: { ...profile.dataRules, syntheticDataOnly: false } },
      repositoryInventory: inventory,
    })).toThrow(/synthetic/i);

    expect(() => new AutomationEngineer().plan({
      design,
      readinessPackage,
      projectProfile: profile,
      repositoryInventory: [{ ...inventory[0]!, path: 'src/request.ts' }],
    })).toThrow(/test path|allowlist|inventory/i);
  });

  it('creates a new test intent only when the path is permitted by the profile', () => {
    const result = new AutomationEngineer().plan({
      design,
      readinessPackage,
      projectProfile: profile,
      repositoryInventory: [inventory[1]!, inventory[2]!],
    });
    expect(result.patchIntents[0]).toMatchObject({ action: 'create', targetPath: 'tests/request-api.spec.ts' });
  });
});
