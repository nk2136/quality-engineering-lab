import { createHash } from 'node:crypto';
import { z } from 'zod';

const FindingCategorySchema = z.enum([
  'traceability',
  'paths',
  'credentials',
  'destructive',
  'framework',
  'bounds',
  'human-decision',
]);

export const AutomationReviewFindingSchema = z.object({
  severity: z.enum(['info', 'warning', 'blocking']),
  category: FindingCategorySchema,
  message: z.string().min(1),
  recommendation: z.string().min(1),
  acceptanceCriteriaIds: z.array(z.string()),
  scenarioIds: z.array(z.string()),
  paths: z.array(z.string()),
});

export const AutomationReviewSchema = z.object({
  schemaVersion: z.literal('1.0'),
  artifactKind: z.literal('automation-review'),
  reviewId: z.string().min(1),
  verdict: z.enum(['approve', 'reject']),
  nextStage: z.enum(['implementation', 'waiting-for-human']),
  findings: z.array(AutomationReviewFindingSchema),
  patchHash: z.string().length(64),
  revision: z.string().min(1),
  artifactIds: z.array(z.string().min(1)),
  reviewSummary: z.string().min(1),
});

export type AutomationReviewFinding = z.infer<typeof AutomationReviewFindingSchema>;
export type AutomationReview = z.infer<typeof AutomationReviewSchema>;

type Row = Record<string, unknown>;

const row = (value: unknown): Row => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
const rows = (value: unknown): Row[] => Array.isArray(value) ? value.map(row) : [];
const strings = (value: unknown): string[] => Array.isArray(value)
  ? value.filter((item): item is string => typeof item === 'string' && item.trim() !== '').map((item) => item.trim())
  : [];
const stringOrStrings = (value: unknown): string[] => typeof value === 'string' && value.trim() !== '' ? [value.trim()] : strings(value);
const text = (value: Row, ...keys: string[]): string => keys
  .map((key) => value[key])
  .find((item): item is string => typeof item === 'string' && item.trim() !== '')
  ?.trim() ?? '';

function globRegex(pattern: string): RegExp {
  let source = '^';
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index]!;
    if (character === '*' && pattern[index + 1] === '*') {
      if (pattern[index + 2] === '/') {
        source += '(?:.*/)?';
        index += 2;
        continue;
      }
      source += '.*';
      index += 1;
    } else if (character === '*') source += '[^/]*';
    else if (character === '?') source += '[^/]';
    else source += character.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`${source}$`);
}

function matchesAny(path: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => pattern === path || globRegex(pattern).test(path));
}

function changedPaths(diff: string): string[] {
  return [...new Set([...diff.matchAll(/^\+\+\+ b\/(.+)$/gm)].map((match) => match[1]!.trim()))];
}

function changedLines(diff: string): number {
  return diff.split(/\r?\n/).filter((line) => (/^\+(?!\+\+\+)/.test(line) || /^-(?!---)/.test(line))).length;
}

function addedText(diff: string): string {
  return diff.split(/\r?\n/).filter((line) => /^\+(?!\+\+\+)/.test(line)).join('\n');
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function designScenarios(design: Row): Row[] {
  return rows(design.scenarios ?? design.testCases ?? design.cases);
}

function scenarioAcIds(scenario: Row): string[] {
  return strings(scenario.acceptanceCriteriaIds ?? scenario.acIds ?? scenario.requirementIds ?? (scenario.acId ? [scenario.acId] : []));
}

function artifactIds(intent: Row, design: Row, input: Row): string[] {
  const explicit = strings(intent.artifactIds ?? intent.artifactLinks ?? input.artifactIds);
  const readiness = text(intent, 'readinessPackageId', 'readinessId') || text(row(input.readinessPackage ?? input.readiness), 'packageId', 'readinessPackageId', 'id');
  const designId = text(intent, 'designId', 'designArtifactId') || text(design, 'designId', 'id');
  return unique([...explicit, readiness, designId].filter(Boolean));
}

function frameworkValues(input: Row): { runner: string; patterns: string[] } {
  const profile = row(input.projectProfile ?? input.profile);
  const conventions = row(input.frameworkConventions ?? profile.frameworkConventions ?? profile);
  return {
    runner: text(conventions, 'testRunner', 'runner', 'framework').toLowerCase(),
    patterns: strings(conventions.testFilePatterns ?? conventions.testPaths ?? conventions.testPatterns),
  };
}

function createFinding(
  severity: AutomationReviewFinding['severity'],
  category: AutomationReviewFinding['category'],
  message: string,
  recommendation: string,
  details: Partial<Pick<AutomationReviewFinding, 'acceptanceCriteriaIds' | 'scenarioIds' | 'paths'>> = {},
): AutomationReviewFinding {
  return AutomationReviewFindingSchema.parse({
    severity,
    category,
    message,
    recommendation,
    acceptanceCriteriaIds: details.acceptanceCriteriaIds ?? [],
    scenarioIds: details.scenarioIds ?? [],
    paths: details.paths ?? [],
  });
}

function reviewTraceability(input: Row, design: Row, intent: Row, findings: AutomationReviewFinding[]): void {
  const acceptanceCriteriaIds = strings(intent.acceptanceCriteriaIds ?? intent.acIds);
  const scenarioIds = strings(intent.scenarioIds);
  const scenarios = designScenarios(design);
  const knownScenarioIds = new Set(scenarios.map((scenario) => text(scenario, 'id', 'scenarioId')));
  const knownAcIds = new Set(scenarios.flatMap(scenarioAcIds));
  const readiness = row(input.readinessPackage ?? input.readiness);
  const readinessAcIds = new Set(rows(readiness.acceptanceCriteria ?? readiness.acs ?? readiness.requirements)
    .map((criterion) => text(criterion, 'id', 'acId', 'requirementId')));
  const designId = text(intent, 'designId', 'designArtifactId') || text(design, 'designId', 'id');

  if (!designId) findings.push(createFinding('blocking', 'traceability', 'Patch intent is missing the accepted test-design artifact ID.', 'Provide the current accepted designId before implementation.'));
  if (acceptanceCriteriaIds.length === 0) findings.push(createFinding('blocking', 'traceability', 'Patch intent does not identify any acceptance criteria.', 'Map the patch to one or more confirmed acceptance-criteria IDs.'));
  if (scenarioIds.length === 0) findings.push(createFinding('blocking', 'traceability', 'Patch intent does not identify any test-design scenarios.', 'Map the patch to one or more accepted scenario IDs.'));

  const missingScenarios = scenarioIds.filter((id) => !knownScenarioIds.has(id));
  if (missingScenarios.length > 0) findings.push(createFinding('blocking', 'traceability', `Patch references unknown scenario IDs: ${missingScenarios.join(', ')}.`, 'Use scenario IDs from the accepted design.', { scenarioIds: missingScenarios }));
  const missingDesignAcs = acceptanceCriteriaIds.filter((id) => !knownAcIds.has(id));
  if (missingDesignAcs.length > 0) findings.push(createFinding('blocking', 'traceability', `Design does not trace scenarios to acceptance criteria: ${missingDesignAcs.join(', ')}.`, 'Add an RTM/design mapping before generating automation.', { acceptanceCriteriaIds: missingDesignAcs, scenarioIds }));
  const missingReadinessAcs = [...readinessAcIds].length > 0 ? acceptanceCriteriaIds.filter((id) => !readinessAcIds.has(id)) : [];
  if (missingReadinessAcs.length > 0) findings.push(createFinding('blocking', 'traceability', `Patch references acceptance criteria absent from the readiness package: ${missingReadinessAcs.join(', ')}.`, 'Refresh the readiness package and use only its current AC IDs.', { acceptanceCriteriaIds: missingReadinessAcs }));

  const revision = text(input, 'revision', 'workflowRevision', 'repositoryRevision') || text(intent, 'revision', 'workflowRevision', 'repositoryRevision');
  const workflowRevision = text(input, 'revision', 'workflowRevision');
  const designRevision = text(design, 'revision', 'sourceRevision');
  if (designRevision && workflowRevision && designRevision !== workflowRevision) findings.push(createFinding('blocking', 'traceability', `Design revision '${designRevision}' does not match workflow revision '${workflowRevision}'.`, 'Rebase the design or review the patch against the current workflow revision.'));
  const intentRevision = text(intent, 'revision', 'workflowRevision');
  if (intentRevision && workflowRevision && intentRevision !== workflowRevision) findings.push(createFinding('blocking', 'traceability', `Patch-intent revision '${intentRevision}' does not match workflow revision '${workflowRevision}'.`, 'Regenerate the patch intent at the current workflow revision.'));
}

function reviewPolicy(input: Row, diff: string, paths: string[], findings: AutomationReviewFinding[]): void {
  const intent = row(input.patchIntent ?? input.intent);
  const profile = row(input.projectProfile ?? input.profile);
  const conventions = row(input.frameworkConventions ?? profile.frameworkConventions ?? profile);
  const allowedPaths = stringOrStrings(input.allowlistedPaths ?? input.allowedPaths ?? intent.allowlistedPaths ?? intent.allowedPaths ?? intent.targetPath ?? conventions.allowedTestPaths ?? conventions.allowedPaths);
  const frameworkPatterns = strings(conventions.testFilePatterns ?? conventions.testPaths ?? conventions.testPatterns);
  const outOfScope = paths.filter((path) => !matchesAny(path, allowedPaths));
  if (allowedPaths.length === 0 && frameworkPatterns.length === 0) findings.push(createFinding('blocking', 'paths', 'No allowlisted paths were supplied for the patch.', 'Provide an explicit test-path allowlist before review.'));
  const conventionMismatches = allowedPaths.length === 0 ? paths.filter((path) => !matchesAny(path, frameworkPatterns)) : [];
  if (conventionMismatches.length > 0) findings.push(createFinding('blocking', 'paths', `Patch changes paths outside the framework test conventions: ${conventionMismatches.join(', ')}.`, 'Regenerate the patch within the configured test-file patterns.', { paths: conventionMismatches }));
  if (outOfScope.length > 0) findings.push(createFinding('blocking', 'paths', `Patch changes paths outside the allowlist: ${outOfScope.join(', ')}.`, 'Regenerate the patch with only approved paths.', { paths: outOfScope }));
  const dependencyPaths = paths.filter((path) => /(^|\/)(?:package(?:-lock)?\.json|yarn\.lock|pnpm-lock\.yaml)$/i.test(path));
  if (dependencyPaths.length > 0) findings.push(createFinding('blocking', 'paths', `Patch changes dependency manifests: ${dependencyPaths.join(', ')}.`, 'Keep automation patches bounded to approved test files.', { paths: dependencyPaths }));
  if (paths.length === 0) findings.push(createFinding('blocking', 'bounds', 'Patch does not contain a unified-diff file header.', 'Provide a reviewable unified diff.'));

  const maxFiles = Number(input.maxChangedFiles ?? input.maxFiles ?? 10);
  const maxLines = Number(input.maxChangedLines ?? input.maxLines ?? 400);
  if (paths.length > maxFiles) findings.push(createFinding('blocking', 'bounds', `Patch changes ${paths.length} files, exceeding the bound of ${maxFiles}.`, 'Split the change into smaller approved patches.', { paths }));
  const lineCount = changedLines(diff);
  if (lineCount > maxLines) findings.push(createFinding('blocking', 'bounds', `Patch changes ${lineCount} lines, exceeding the bound of ${maxLines}.`, 'Reduce the patch to the accepted scenarios.', { paths }));
  const maxBytes = Number(input.maxPatchBytes ?? 100_000);
  if (Buffer.byteLength(diff, 'utf8') > maxBytes) findings.push(createFinding('blocking', 'bounds', `Patch exceeds the ${maxBytes}-byte bound.`, 'Submit a smaller patch.', { paths }));
}

function reviewSecurity(diff: string, findings: AutomationReviewFinding[]): void {
  const textValue = addedText(diff);
  const credentialPattern = /(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY|(?:api[_-]?key|access[_-]?token|client[_-]?secret|password)\s*[:=]\s*['"][^'"]{4,}|authorization\s*[:=].{0,20}bearer\s+[A-Za-z0-9._-]{12,})/i;
  if (credentialPattern.test(textValue)) findings.push(createFinding('blocking', 'credentials', 'Patch contains a possible credential or private key.', 'Use synthetic fixtures and runtime-auth references; never commit secrets.'));
  const destructivePattern = /(?:rm\s+-[a-z]*r|remove-item\s+[^\n]*-(?:recurse|force)|git\s+(?:reset\s+--hard|clean\s+-[^\n]*f)|(?:drop|truncate)\s+(?:table|database)|delete\s+from\s+|fs\.(?:rm|rmSync|unlink|unlinkSync)|docker\s+(?:system\s+prune|rm\s+-f)|kubectl\s+delete)/i;
  if (destructivePattern.test(textValue)) findings.push(createFinding('blocking', 'destructive', 'Patch contains a destructive command or operation.', 'Remove destructive operations; automation review permits reversible test actions only.'));
}

function reviewDataRules(input: Row, findings: AutomationReviewFinding[]): void {
  const intent = row(input.patchIntent ?? input.intent);
  const profile = row(input.projectProfile ?? input.profile);
  const dataRules = row(profile.dataRules);
  if (intent.syntheticDataOnly === false || dataRules.syntheticDataOnly === false || dataRules.secretsAllowed === true) {
    findings.push(createFinding('blocking', 'credentials', 'Patch intent or project profile permits non-synthetic data or secrets.', 'Use only approved synthetic fixtures, mocks, or local artifacts.'));
  }
}

function reviewFramework(input: Row, diff: string, paths: string[], findings: AutomationReviewFinding[]): void {
  const { runner: configuredRunner, patterns } = frameworkValues(input);
  const intent = row(input.patchIntent ?? input.intent);
  const runner = configuredRunner || text(intent, 'testRunner', 'framework').toLowerCase();
  if (patterns.length > 0) {
    const mismatches = paths.filter((path) => !matchesAny(path, patterns));
    if (mismatches.length > 0) findings.push(createFinding('blocking', 'framework', `Changed files do not match framework test-file conventions: ${mismatches.join(', ')}.`, 'Place automation in the configured test-file patterns.', { paths: mismatches }));
  }
  const added = addedText(diff);
  if (runner === 'vitest' && /@playwright\/test|\bfrom\s+['"]jest['"]/.test(added)) findings.push(createFinding('blocking', 'framework', 'Patch imports a test runner that differs from the configured Vitest convention.', 'Use the configured Vitest runner and existing helpers.'));
  if (runner === 'playwright' && /\bfrom\s+['"]vitest['"]|\bfrom\s+['"]jest['"]/.test(added)) findings.push(createFinding('blocking', 'framework', 'Patch imports a test runner that differs from the configured Playwright convention.', 'Use the configured Playwright runner and existing helpers.'));
  if (configuredRunner && text(intent, 'testRunner', 'framework') && configuredRunner !== text(intent, 'testRunner', 'framework').toLowerCase()) findings.push(createFinding('blocking', 'framework', `Patch intent uses '${text(intent, 'testRunner', 'framework')}' but the project convention is '${configuredRunner}'.`, 'Regenerate the intent against the current framework profile.'));
  if (intent.scope !== undefined && intent.scope !== 'test-only') findings.push(createFinding('blocking', 'framework', 'Patch intent is not bounded to test-only changes.', 'Use a test-only automation patch intent.'));
  if (/\b(?:test|it|describe)\.only\s*\(|\b(?:test|it|describe)\.skip\s*\(/.test(added)) findings.push(createFinding('blocking', 'framework', 'Patch focuses or skips a test.', 'Do not commit focused or skipped tests.'));
}

/** Review an automation patch without executing it or changing repository state. */
export function reviewAutomationPatch(value: unknown): AutomationReview {
  const input = row(value);
  const intent = row(input.patchIntent ?? input.intent);
  const diff = typeof input.diff === 'string' ? input.diff : typeof intent.diff === 'string' ? intent.diff : '';
  const revision = text(input, 'revision', 'workflowRevision', 'repositoryRevision') || text(intent, 'revision', 'workflowRevision', 'repositoryRevision');
  const design = row(input.design ?? input.testDesign);
  const paths = changedPaths(diff);
  const findings: AutomationReviewFinding[] = [];

  if (!diff) findings.push(createFinding('blocking', 'bounds', 'Patch diff is required.', 'Provide the generated unified diff.'));
  if (!revision) findings.push(createFinding('blocking', 'traceability', 'Workflow revision is required.', 'Bind the review to the current workflow revision.'));
  reviewTraceability(input, design, intent, findings);
  reviewPolicy(input, diff, paths, findings);
  reviewSecurity(diff, findings);
  reviewDataRules(input, findings);
  reviewFramework(input, diff, paths, findings);

  const humanDecision = input.humanDecision ?? intent.humanDecision ?? input.pendingQuestions;
  if (humanDecision !== undefined && humanDecision !== null && (typeof humanDecision === 'string' || (Array.isArray(humanDecision) && humanDecision.length > 0) || (typeof humanDecision === 'object' && Object.keys(row(humanDecision)).length > 0))) {
    findings.push(createFinding('warning', 'human-decision', 'Patch review has an unresolved human decision.', 'Resolve the decision before requesting SDET approval.'));
  }

  const hasBlocking = findings.some((finding) => finding.severity === 'blocking');
  const hasHumanDecision = findings.some((finding) => finding.category === 'human-decision');
  const verdict = hasBlocking || hasHumanDecision ? 'reject' : 'approve';
  const nextStage = hasHumanDecision && !hasBlocking ? 'waiting-for-human' : 'implementation';
  const patchHash = createHash('sha256').update(diff).digest('hex');
  const ids = artifactIds(intent, design, input);
  return AutomationReviewSchema.parse({
    schemaVersion: '1.0',
    artifactKind: 'automation-review',
    reviewId: `automation-review:${revision || 'unbound'}:${patchHash}`,
    verdict,
    nextStage,
    findings,
    patchHash,
    revision: revision || 'unbound',
    artifactIds: ids,
    reviewSummary: verdict === 'approve' ? 'Automation patch is traceable, bounded, and policy compliant.' : 'Automation patch requires revision or an explicit human decision.',
  });
}

export const reviewAutomation = reviewAutomationPatch;

export class AutomationReviewer {
  review(input: unknown): AutomationReview {
    return reviewAutomationPatch(input);
  }
}
