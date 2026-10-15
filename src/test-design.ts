import { z } from 'zod';

/**
 * Test design is deliberately an execution-neutral artifact. It describes
 * behavior and evidence boundaries; it never emits selectors, endpoint URLs,
 * framework imports, or test code.
 */

export const TestScenarioCategorySchema = z.enum([
  'positive',
  'negative',
  'boundary',
  'error',
  'data-validation',
  'permission',
  'idempotency',
  'ordering',
  'recovery',
]);

export const TestDesignStrategySchema = z.object({
  style: z.literal('bdd'),
  interactionModel: z.enum(['page-object', 'api-agnostic', 'framework-neutral']),
  apiAgnostic: z.literal(true),
  conventions: z.array(z.string().min(1)),
});

export const TestScenarioSchema = z.object({
  id: z.string().regex(/^SCENARIO-\d{3}$/),
  title: z.string().min(1),
  category: TestScenarioCategorySchema,
  acceptanceCriteriaIds: z.array(z.string().min(1)).min(1),
  evidenceIds: z.array(z.string().min(1)).min(1),
  setup: z.array(z.string().min(1)).min(1),
  data: z.array(z.string().min(1)).min(1),
  given: z.array(z.string().min(1)).min(1),
  when: z.array(z.string().min(1)).min(1),
  then: z.array(z.string().min(1)).min(1),
  observables: z.array(z.string().min(1)).min(1),
  cleanup: z.array(z.string().min(1)).min(1),
  assumptions: z.array(z.string()),
});

export const TestDesignSchema = z.object({
  schemaVersion: z.literal('1.0'),
  artifactKind: z.literal('test-design'),
  designId: z.string().min(1),
  traceId: z.string().min(1),
  storyKey: z.string().min(1),
  revision: z.string().min(1),
  component: z.string().min(1),
  strategy: TestDesignStrategySchema,
  scenarios: z.array(TestScenarioSchema),
  rtm: z.array(z.object({
    id: z.string().min(1),
    acId: z.string().min(1),
    scenarioIds: z.array(z.string().min(1)).min(1),
    evidenceIds: z.array(z.string().min(1)).min(1),
  })),
  requiredTestData: z.array(z.string().min(1)),
  outOfScope: z.array(z.string().min(1)),
  decision: z.enum(['ready', 'waiting-for-human']),
  humanDecision: z.object({
    status: z.enum(['not-required', 'pending']),
    questions: z.array(z.string().min(1)),
  }),
  codeGeneration: z.literal(false),
});

export type TestScenarioCategory = z.infer<typeof TestScenarioCategorySchema>;
export type TestDesignStrategy = z.infer<typeof TestDesignStrategySchema>;
export type TestScenario = z.infer<typeof TestScenarioSchema>;
export type TestDesign = z.infer<typeof TestDesignSchema>;

export interface TestDesignInput {
  readonly readinessPackage: unknown;
  readonly projectProfile?: unknown;
  /** Alias accepted for callers that use the shorter profile name. */
  readonly profile?: unknown;
  /** Optional explicit RTM for artifact consumers that store it separately. */
  readonly rtm?: unknown;
}

type RecordValue = Record<string, unknown>;

interface Criterion {
  readonly id: string;
  readonly statement: string;
  readonly evidenceIds: string[];
}

interface RtmRow {
  readonly id: string;
  readonly acId: string;
  readonly observableOutcome: string;
  readonly evidenceIds: string[];
}

interface PackageFacts {
  readonly storyKey: string;
  readonly revision: string;
  readonly traceId: string;
  readonly component: string;
  readonly criteria: Criterion[];
  readonly rtm: RtmRow[];
  readonly prerequisites: RecordValue[];
  readonly clarifications: RecordValue[];
  readonly blockers: RecordValue[];
  readonly discrepancies: RecordValue[];
}

function record(value: unknown): RecordValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as RecordValue
    : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim() !== '').map((item) => item.trim())
    : [];
}

function records(value: unknown): RecordValue[] {
  return Array.isArray(value) ? value.map(record).filter((item) => Object.keys(item).length > 0) : [];
}

function firstString(source: RecordValue, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const found = stringValue(source[key]);
    if (found !== undefined) return found;
  }
  return undefined;
}

function ids(source: RecordValue, fallback?: string): string[] {
  const result = stringArray(source.evidenceIds);
  if (result.length === 0 && fallback !== undefined) result.push(fallback);
  return [...new Set(result)];
}

function normalizeCriteria(value: unknown): Criterion[] {
  return records(value).flatMap((item, index) => {
    const id = firstString(item, 'id', 'acId', 'acceptanceCriterionId') ?? `AC-${index + 1}`;
    const statement = firstString(item, 'statement', 'expectedBehavior', 'description');
    return statement === undefined ? [] : [{ id, statement, evidenceIds: ids(item, item.id as string | undefined) }];
  });
}

function normalizeRtm(value: unknown): RtmRow[] {
  return records(value).flatMap((item, index) => {
    const acId = firstString(item, 'acId', 'acceptanceCriterionId', 'requirementId');
    const observableOutcome = firstString(item, 'observableOutcome', 'observedOutcome', 'expectedBehavior');
    if (acId === undefined || observableOutcome === undefined) return [];
    return [{
      id: firstString(item, 'id') ?? `RTM-${String(index + 1).padStart(3, '0')}`,
      acId,
      observableOutcome,
      evidenceIds: ids(item, item.id as string | undefined),
    }];
  });
}

function normalizePackage(value: unknown, explicitRtm: unknown): PackageFacts {
  const source = record(value);
  const identity = record(source.storyIdentity);
  const storyKey = firstString(source, 'storyKey') ?? firstString(identity, 'key', 'storyKey');
  const revision = firstString(source, 'revision', 'sourceRevision');
  const traceId = firstString(source, 'traceId');
  const component = firstString(source, 'component') ?? firstString(record(source.componentSelection), 'name');
  const criteria = normalizeCriteria(source.acceptanceCriteria ?? source.acs);
  const rtm = normalizeRtm(explicitRtm ?? source.rtm ?? source.requirementsTraceabilityMatrix);
  if (storyKey === undefined || revision === undefined || traceId === undefined || component === undefined) {
    throw new Error('A validated readiness package must include storyKey, revision, traceId, and component.');
  }
  if (criteria.length === 0) throw new Error('A validated readiness package must contain acceptance criteria.');
  if (rtm.length === 0) throw new Error('A validated readiness package must contain an RTM.');
  const decision = firstString(source, 'readinessDecision', 'proposedReadinessDecision');
  if (decision !== 'ready' && decision !== 'ready-for-design') {
    throw new Error(`Test design requires a ready-for-design readiness package; received '${decision ?? 'missing'}'.`);
  }
  const clarifications = records(source.ownedClarifications ?? source.clarifications);
  const blockers = records(source.phaseSpecificBlockers ?? source.blockers);
  if (clarifications.length > 0 || blockers.length > 0) {
    throw new Error('Test design cannot consume a readiness package with unresolved clarifications or blockers.');
  }
  const rtmByAc = new Set(rtm.map((row) => row.acId));
  const missingRtm = criteria.map((item) => item.id).filter((id) => !rtmByAc.has(id));
  if (missingRtm.length > 0) throw new Error(`RTM is missing acceptance criteria: ${missingRtm.join(', ')}.`);
  return {
    storyKey,
    revision,
    traceId,
    component,
    criteria,
    rtm,
    prerequisites: records(source.accessDataPrerequisites ?? source.prerequisites),
    clarifications,
    blockers,
    discrepancies: records(source.discrepancyRows ?? source.discrepancies),
  };
}

function flattenText(value: unknown): string[] {
  if (typeof value === 'string' && value.trim() !== '') return [value.trim()];
  if (Array.isArray(value)) return value.flatMap(flattenText);
  if (typeof value === 'object' && value !== null) return Object.values(value).flatMap(flattenText);
  return [];
}

function profileConventions(value: unknown): string[] {
  const profile = record(value);
  return [...new Set([
    ...flattenText(profile.frameworkConventions),
    ...flattenText(profile.testConventions),
    ...flattenText(profile.testingConventions),
    ...flattenText(profile.framework),
    ...flattenText(profile.conventions),
  ])];
}

function strategy(value: unknown): TestDesignStrategy | undefined {
  const profile = record(value);
  const conventions = profileConventions(value);
  const explicitStyle = firstString(profile, 'scenarioStyle', 'testStyle', 'style');
  const text = conventions.join(' ').toLowerCase();
  const styleIsBdd = explicitStyle === undefined
    ? /bdd|gherkin|given\s+when\s+then/.test(text)
    : /bdd|gherkin/.test(explicitStyle);
  if (!styleIsBdd) return undefined;
  const explicitModel = firstString(profile, 'interactionModel', 'testInteractionModel');
  const interactionModel = explicitModel !== undefined && /page.?object|pom/i.test(explicitModel)
    ? 'page-object'
    : /page.?object|pom/i.test(text)
      ? 'page-object'
      : explicitModel !== undefined && /api.?agnostic/i.test(explicitModel)
        ? 'api-agnostic'
        : 'framework-neutral';
  return { style: 'bdd', interactionModel, apiAgnostic: true, conventions };
}

function applicableCategories(statement: string): TestScenarioCategory[] {
  const lower = statement.toLowerCase();
  const categories: TestScenarioCategory[] = ['positive'];
  if (/invalid|reject|deny|forbidden|unauthori[sz]|negative|must not|without permission/.test(lower)) categories.push('negative');
  if (/boundar|maximum|minimum|\bmax\b|\bmin\b|limit|range|zero|empty|null|length|first|last/.test(lower)) categories.push('boundary');
  if (/validat|input|value|field|format|schema|data/.test(lower)) categories.push('data-validation');
  if (/error|fail|failure|exception|timeout|unavailable|unreachable|retry/.test(lower)) categories.push('error');
  if (/permission|role|access|authori[sz]|forbidden|unauthori[sz]/.test(lower)) categories.push('permission');
  if (/idempotent|duplicate|exactly once|repeat|retry/.test(lower)) categories.push('idempotency');
  if (/order|sequence|before|after|sorted/.test(lower)) categories.push('ordering');
  if (/recover|resume|rollback|restore|outage/.test(lower)) categories.push('recovery');
  return categories;
}

function prerequisiteText(prerequisites: readonly RecordValue[], fallback: string): string[] {
  const descriptions = prerequisites.map((item) => firstString(item, 'description', 'statement', 'text')).filter((item): item is string => item !== undefined);
  return descriptions.length > 0 ? descriptions : [fallback];
}

function statusUnknown(prerequisites: readonly RecordValue[]): boolean {
  return prerequisites.some((item) => /unknown|unavailable|missing|blocked/i.test(firstString(item, 'status') ?? ''));
}

function buildScenario(
  facts: PackageFacts,
  criterion: Criterion,
  rtm: RtmRow,
  category: TestScenarioCategory,
  sequence: number,
): TestScenario {
  const evidenceIds = [...new Set([...criterion.evidenceIds, ...rtm.evidenceIds])];
  const observable = rtm.observableOutcome;
  const setup = prerequisiteText(facts.prerequisites, `Use only setup conditions evidenced for ${criterion.id}.`);
  const data = prerequisiteText(facts.prerequisites, `Use approved data evidenced for ${criterion.id}; do not invent values.`);
  const qualifier = category === 'positive'
    ? 'the behavior described by the acceptance criterion'
    : `the ${category} condition described by the acceptance criterion`;
  const expected = category === 'positive'
    ? observable
    : `${observable} remains true when ${qualifier} is exercised.`;
  return {
    id: `SCENARIO-${String(sequence).padStart(3, '0')}`,
    title: `${criterion.id} — ${category} behavior`,
    category,
    acceptanceCriteriaIds: [criterion.id],
    evidenceIds,
    setup,
    data,
    given: [`Given the validated prerequisites for ${facts.storyKey} are satisfied.`, ...setup],
    when: [`When ${qualifier} is exercised.`],
    then: [expected],
    observables: [observable],
    cleanup: ['Restore state using the project profile cleanup convention or leave no persistent changes.'],
    assumptions: [],
  };
}

function normalizeInput(value: unknown, profileArgument?: unknown): { packageValue: unknown; profileValue: unknown; rtm: unknown } {
  const input = record(value);
  if ('readinessPackage' in input || 'package' in input) {
    return {
      packageValue: input.readinessPackage ?? input.package,
      profileValue: input.projectProfile ?? input.profile ?? profileArgument,
      rtm: input.rtm,
    };
  }
  return { packageValue: value, profileValue: profileArgument, rtm: undefined };
}

/** Build a design artifact from a validated readiness package and profile. */
export function buildTestDesign(value: unknown, profileArgument?: unknown): TestDesign {
  const normalized = normalizeInput(value, profileArgument);
  const facts = normalizePackage(normalized.packageValue, normalized.rtm);
  const selectedStrategy = strategy(normalized.profileValue);
  const conventionQuestions: string[] = selectedStrategy === undefined
    ? ['Which BDD and interaction conventions should the test suite use?']
    : [];
  const dataQuestions = statusUnknown(facts.prerequisites)
    ? ['Who will provide and approve the unresolved test data or environment prerequisite?']
    : [];
  const questions = [...conventionQuestions, ...dataQuestions];
  if (questions.length > 0) {
    return TestDesignSchema.parse({
      schemaVersion: '1.0',
      artifactKind: 'test-design',
      designId: `test-design:${facts.storyKey}:${facts.revision}`,
      traceId: facts.traceId,
      storyKey: facts.storyKey,
      revision: facts.revision,
      component: facts.component,
      strategy: selectedStrategy ?? { style: 'bdd', interactionModel: 'framework-neutral', apiAgnostic: true, conventions: [] },
      scenarios: [],
      rtm: [],
      requiredTestData: [],
      outOfScope: ['Scenario generation is paused until the pending human decisions are resolved.'],
      decision: 'waiting-for-human',
      humanDecision: { status: 'pending', questions },
      codeGeneration: false,
    });
  }

  const scenarioRows: TestScenario[] = [];
  let sequence = 1;
  const scenarioIdsByAc = new Map<string, string[]>();
  for (const criterion of facts.criteria) {
    const rtm = facts.rtm.find((row) => row.acId === criterion.id)!;
    const idsForAc: string[] = [];
    for (const category of applicableCategories(criterion.statement)) {
      const scenario = buildScenario(facts, criterion, rtm, category, sequence++);
      scenarioRows.push(scenario);
      idsForAc.push(scenario.id);
    }
    scenarioIdsByAc.set(criterion.id, idsForAc);
  }

  return TestDesignSchema.parse({
    schemaVersion: '1.0',
    artifactKind: 'test-design',
    designId: `test-design:${facts.storyKey}:${facts.revision}`,
    traceId: facts.traceId,
    storyKey: facts.storyKey,
    revision: facts.revision,
    component: facts.component,
    strategy: selectedStrategy!,
    scenarios: scenarioRows,
    rtm: facts.rtm.map((row) => ({
      id: row.id,
      acId: row.acId,
      scenarioIds: scenarioIdsByAc.get(row.acId) ?? [],
      evidenceIds: row.evidenceIds,
    })),
    requiredTestData: [...new Set(facts.prerequisites.map((item) => firstString(item, 'description', 'statement', 'text')).filter((item): item is string => item !== undefined))],
    outOfScope: ['Framework-specific code, selectors, endpoint details, and credentials are out of scope for test design.'],
    decision: 'ready',
    humanDecision: { status: 'not-required', questions: [] },
    codeGeneration: false,
  });
}

export const generateTestDesign = buildTestDesign;
export const designTests = buildTestDesign;

export class TestDesigner {
  design(input: TestDesignInput): TestDesign {
    return buildTestDesign(input);
  }
}
