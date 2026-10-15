import { z } from 'zod';
import { TestDesignSchema, type TestDesign } from './test-design.js';

const PathSchema = z.string().min(1).refine((value) => !value.startsWith('/') && !value.includes('\\') && !value.split('/').includes('..'), 'Paths must be repository-relative.');

export const AutomationPatchIntentSchema = z.object({
  intentId: z.string().min(1),
  action: z.enum(['create', 'extend']),
  targetPath: PathSchema,
  scope: z.literal('test-only'),
  framework: z.enum(['vitest', 'playwright']),
  testRunner: z.enum(['vitest', 'playwright']),
  designArtifactId: z.string().min(1),
  readinessPackageId: z.string().min(1),
  repositoryRevision: z.string().min(1),
  storyKey: z.string().min(1),
  scenarioIds: z.array(z.string().min(1)).min(1),
  acceptanceCriteriaIds: z.array(z.string().min(1)).min(1),
  artifactLinks: z.array(z.string().min(1)).min(2),
  operations: z.array(z.enum(['add-scenario', 'extend-suite', 'reuse-page-object', 'reuse-fixture'])).min(1),
  syntheticDataOnly: z.literal(true),
  dataSources: z.array(z.enum(['fixtures', 'mocks', 'local-artifacts'])).min(1),
  rationale: z.string().min(1),
}).strict();

export type AutomationPatchIntent = z.infer<typeof AutomationPatchIntentSchema>;

export const AutomationPlanSchema = z.object({
  decision: z.enum(['ready', 'blocked']),
  designArtifactId: z.string().min(1),
  readinessPackageId: z.string().min(1),
  repositoryRevision: z.string().min(1),
  patchIntents: z.array(AutomationPatchIntentSchema),
  blockers: z.array(z.string()),
  warnings: z.array(z.string()),
}).strict();

export type AutomationPlan = z.infer<typeof AutomationPlanSchema>;

export interface AutomationEngineerInput {
  readonly design?: unknown;
  readonly testDesign?: unknown;
  readonly readinessPackage: unknown;
  readonly projectProfile: unknown;
  readonly repositoryInventory?: unknown;
  readonly inventory?: unknown;
}

interface InventoryEntry {
  readonly path: string;
  readonly revision: string;
  readonly kind?: string;
}

interface ProfileRules {
  readonly runner: 'vitest' | 'playwright';
  readonly testDirectory: string;
  readonly testPatterns: readonly string[];
  readonly explicitPaths: readonly string[];
  readonly dataSources: readonly ('fixtures' | 'mocks' | 'local-artifacts')[];
  readonly syntheticDataOnly: true;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function textList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim() !== '').map((item) => item.trim()) : [];
}

function profileRules(value: unknown): ProfileRules {
  const profile = record(value);
  const conventions = record(profile.frameworkConventions);
  const runnerValue = text(conventions.testRunner) ?? text(profile.testRunner);
  if (runnerValue !== 'vitest' && runnerValue !== 'playwright') throw new Error('Automation requires a supported framework/test runner convention (vitest or playwright).');
  const testDirectory = text(conventions.testDirectory) ?? text(profile.testDirectory) ?? 'tests';
  const patterns = textList(conventions.testFilePatterns ?? profile.testFilePatterns);
  const explicitPaths = textList(conventions.allowedTestPaths ?? profile.allowedTestPaths ?? profile.allowedPaths);
  const dataRules = record(profile.dataRules);
  if (dataRules.syntheticDataOnly !== true || dataRules.secretsAllowed === true) throw new Error('Automation requires synthetic test data and forbids secrets.');
  const configuredSources = textList(dataRules.allowedDataSources);
  const dataSources = configuredSources.filter((source): source is ProfileRules['dataSources'][number] => ['fixtures', 'mocks', 'local-artifacts'].includes(source));
  if (dataSources.length === 0) throw new Error('Automation requires an allowed synthetic data source.');
  return { runner: runnerValue, testDirectory: trimSlashes(testDirectory), testPatterns: patterns, explicitPaths, dataSources, syntheticDataOnly: true };
}

function trimSlashes(value: string): string {
  return value.replace(/^\/+|\/+$/g, '');
}

function inventoryEntries(value: unknown): InventoryEntry[] {
  const source = record(value);
  const rows = Array.isArray(value) ? value : source.entries ?? source.files ?? source.inventory;
  if (!Array.isArray(rows)) throw new Error('Repository inventory must be an array or an object containing entries/files.');
  return rows.map((item) => {
    const row = record(item);
    const path = text(row.path);
    const revision = text(row.revision);
    if (path === undefined || revision === undefined) throw new Error('Repository inventory entries require path and revision.');
    const kind = text(row.kind);
    return kind === undefined ? { path, revision } : { path, revision, kind };
  });
}

function globRegex(pattern: string): RegExp {
  let result = '';
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index]!;
    if (character === '*' && pattern[index + 1] === '*') {
      if (pattern[index + 2] === '/') {
        result += '(?:.*/)?';
        index += 2;
        continue;
      }
      result += '.*';
      index += 1;
    } else if (character === '*') {
      result += '[^/]*';
    } else {
      result += /[.+?^${}()|[\]\\]/.test(character) ? `\\${character}` : character;
    }
  }
  return new RegExp(`^${result}$`);
}

function allowedPath(path: string, rules: ProfileRules): boolean {
  if (!path.startsWith(`${rules.testDirectory}/`)) return false;
  if (rules.explicitPaths.length > 0) return rules.explicitPaths.includes(path);
  if (rules.testPatterns.length === 0) return /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path);
  return rules.testPatterns.some((pattern) => globRegex(pattern).test(path));
}

function testPath(pattern: string | undefined, rules: ProfileRules, component: string): string {
  const slug = component.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'story';
  const selected = pattern ?? `${rules.testDirectory}/**/*.${rules.runner === 'playwright' ? 'spec' : 'test'}.ts`;
  const normalized = selected.replace(/\\/g, '/');
  const directory = normalized.slice(0, normalized.indexOf('*')).replace(/\/$/, '') || rules.testDirectory;
  const extensionMatch = normalized.match(/\.(spec|test)\.([cm]?[jt]sx?)$/);
  const suffix = extensionMatch ? `.${extensionMatch[1]}.${extensionMatch[2]}` : `.${rules.runner === 'playwright' ? 'spec' : 'test'}.ts`;
  return `${directory}/${slug}${suffix}`.replace(/\/+/g, '/');
}

function relevantTest(entry: InventoryEntry, design: TestDesign): boolean {
  const path = entry.path.toLowerCase();
  const componentTokens = design.component.toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length > 2);
  const storyToken = design.storyKey.toLowerCase();
  return componentTokens.some((token) => path.includes(token)) || path.includes(storyToken);
}

function packageId(value: unknown): string {
  const source = record(value);
  const id = text(source.packageId) ?? text(source.readinessPackageId) ?? text(source.artifactId) ?? text(source.id);
  if (id === undefined) throw new Error('Automation requires a readiness packageId for artifact linkage.');
  return id;
}

function testDesign(value: unknown): TestDesign {
  const design = TestDesignSchema.parse(value);
  if (design.decision !== 'ready' || design.humanDecision.status !== 'not-required') throw new Error('Automation requires a ready test design with no pending human decision.');
  if (design.scenarios.length === 0) throw new Error('Automation requires at least one accepted test scenario.');
  if (design.codeGeneration !== false) throw new Error('Automation only accepts execution-neutral test designs.');
  return design;
}

function designEvidence(design: TestDesign): string[] {
  return [...new Set(design.scenarios.flatMap((scenario) => scenario.evidenceIds))];
}

/**
 * Converts a validated design into reviewable scope only. It never writes files,
 * creates a diff, runs a command, or grants approval.
 */
export class AutomationEngineer {
  plan(input: AutomationEngineerInput): AutomationPlan {
    const design = testDesign(input.design ?? input.testDesign);
    const readiness = record(input.readinessPackage);
    const readinessId = packageId(input.readinessPackage);
    const readinessTrace = text(readiness.traceId);
    if (readinessTrace !== undefined && readinessTrace !== design.traceId) throw new Error('Design and readiness package trace IDs do not match.');
    const rules = profileRules(input.projectProfile);
    const conventionText = design.strategy.conventions.join(' ').toLowerCase();
    if ((rules.runner === 'playwright' && /vitest/.test(conventionText)) || (rules.runner === 'vitest' && /playwright/.test(conventionText))) {
      throw new Error('Test design conventions do not match the project framework convention.');
    }
    const inventory = inventoryEntries(input.repositoryInventory ?? input.inventory);
    const revisions = [...new Set(inventory.map((entry) => entry.revision))];
    const repositoryRevision = revisions[0];
    if (repositoryRevision === undefined) throw new Error('Repository inventory must contain at least one pinned revision.');
    if (revisions.length !== 1) throw new Error('Repository inventory must be pinned to one consistent revision.');
    const declaredRevisions = record(input.projectProfile).repositories;
    if (Array.isArray(declaredRevisions)) {
      const profileRevisions = declaredRevisions.map((value) => text(record(value).revision)).filter((value): value is string => value !== undefined);
      if (profileRevisions.length > 0 && !profileRevisions.includes(repositoryRevision)) throw new Error('Repository inventory revision does not match the project profile revision.');
    }
    const designData = [
      ...design.requiredTestData,
      ...design.scenarios.flatMap((scenario) => [...scenario.data, ...scenario.assumptions]),
    ].join('\n');
    if (/\bproduction\b|real customer|api[ -]?key|password|secret|credential/i.test(designData)) throw new Error('Automation design requests non-synthetic or secret data.');
    const tests = inventory.filter((entry) => entry.kind === 'test' || /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(entry.path));
    const unallowlistedTests = tests.filter((entry) => !allowedPath(entry.path, rules));
    if (unallowlistedTests.length > 0) throw new Error(`Repository inventory contains test paths outside the profile allowlist: ${unallowlistedTests.map((entry) => entry.path).join(', ')}.`);
    const existing = tests.find((entry) => allowedPath(entry.path, rules) && relevantTest(entry, design));
    const targetPath = existing?.path ?? testPath(rules.testPatterns[0], rules, design.component);
    if (!allowedPath(targetPath, rules)) throw new Error(`Target path '${targetPath}' is not allowed by the project test path conventions.`);
    const evidenceIds = designEvidence(design);
    const pageObjectAvailable = inventory.some((entry) => entry.kind === 'page-object');
    if (design.strategy.interactionModel === 'page-object' && !pageObjectAvailable) return {
      decision: 'blocked', designArtifactId: design.designId, readinessPackageId: readinessId, repositoryRevision,
      patchIntents: [], blockers: ['The accepted design requires a page object, but repository inventory contains none.'], warnings: [],
    };
    const scenarioIds = design.scenarios.map((scenario) => scenario.id);
    const acceptanceCriteriaIds = [...new Set(design.scenarios.flatMap((scenario) => scenario.acceptanceCriteriaIds))];
    const artifactLinks = [design.designId, readinessId, ...evidenceIds];
    const intent = AutomationPatchIntentSchema.parse({
      intentId: `automation:${design.storyKey}:${design.revision}`,
      action: existing === undefined ? 'create' : 'extend',
      targetPath,
      scope: 'test-only',
      framework: rules.runner,
      testRunner: rules.runner,
      designArtifactId: design.designId,
      readinessPackageId: readinessId,
      repositoryRevision,
      storyKey: design.storyKey,
      scenarioIds,
      acceptanceCriteriaIds,
      artifactLinks,
      operations: [existing === undefined ? 'add-scenario' : 'extend-suite', ...(pageObjectAvailable ? ['reuse-page-object'] : []), ...(inventory.some((entry) => entry.kind === 'fixture') ? ['reuse-fixture'] : [])],
      syntheticDataOnly: rules.syntheticDataOnly,
      dataSources: [...rules.dataSources],
      rationale: existing === undefined ? 'Create one test-only file matching the pinned framework convention.' : `Extend existing test coverage at ${targetPath}; do not create a duplicate suite.`,
    });
    return AutomationPlanSchema.parse({
      decision: 'ready', designArtifactId: design.designId, readinessPackageId: readinessId, repositoryRevision,
      patchIntents: [intent], blockers: [], warnings: [],
    });
  }

  generate(input: AutomationEngineerInput): AutomationPlan {
    return this.plan(input);
  }
}

export const planAutomation = (input: AutomationEngineerInput): AutomationPlan => new AutomationEngineer().plan(input);
export const generateAutomationPlan = planAutomation;
export const buildAutomationPlan = planAutomation;
