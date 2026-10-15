import { z } from 'zod';

export const TestDesignReviewFindingSchema = z.object({
  severity: z.enum(['info', 'warning', 'blocking']),
  category: z.enum(['coverage', 'traceability', 'duplicate', 'assumption', 'blocker', 'flakiness']),
  message: z.string().min(1),
  recommendation: z.string().min(1),
  scenarioIds: z.array(z.string()),
  evidenceIds: z.array(z.string()),
});

export const TestDesignReviewSchema = z.object({
  verdict: z.enum(['approve', 'revise', 'reject']),
  score: z.number().int().min(0).max(100),
  findings: z.array(TestDesignReviewFindingSchema),
  missingCoverage: z.array(z.string()),
  nextStage: z.enum(['planning', 'implementation']),
  reviewSummary: z.string().min(1),
});

export type TestDesignReviewFinding = z.infer<typeof TestDesignReviewFindingSchema>;
export type TestDesignReview = z.infer<typeof TestDesignReviewSchema>;
type Row = Record<string, unknown>;

const row = (value: unknown): Row => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
const rows = (value: unknown): Row[] => Array.isArray(value) ? value.map(row).filter((item) => Object.keys(item).length > 0) : [];
const strings = (value: unknown): string[] => Array.isArray(value)
  ? value.filter((item): item is string => typeof item === 'string' && item.trim() !== '').map((item) => item.trim())
  : [];
const unique = (values: readonly string[]): string[] => [...new Set(values)];

function text(value: Row, ...keys: string[]): string {
  for (const key of keys) {
    if (typeof value[key] === 'string' && (value[key] as string).trim() !== '') return (value[key] as string).trim();
  }
  return '';
}

function id(value: Row): string {
  return text(value, 'id', 'scenarioId', 'caseId');
}

function criterionId(value: Row): string {
  return text(value, 'id', 'acId', 'acceptanceCriterionId', 'requirementId');
}

function scenarioAcIds(value: Row): string[] {
  return unique([
    ...strings(value.acceptanceCriteriaIds),
    ...strings(value.acIds),
    ...strings(value.requirementIds),
    ...(typeof value.acId === 'string' && value.acId.trim() !== '' ? [value.acId.trim()] : []),
  ]);
}

function scenarioEvidenceIds(value: Row): string[] {
  return unique(strings(value.evidenceIds));
}

function mapCategory(value: string): string | undefined {
  const input = value.toLowerCase();
  if (/negative|reject|invalid|denied|forbidden/.test(input)) return 'negative';
  if (/boundary|limit|edge|empty|null|zero|maximum|minimum/.test(input)) return 'boundary';
  if (/error|fail|exception|timeout|unavailable/.test(input)) return 'error';
  if (/positive|happy|success|valid/.test(input)) return 'positive';
  return undefined;
}

function scenarioCategories(value: Row): Set<string> {
  const explicit = [
    ...strings(value.categories),
    ...(typeof value.category === 'string' ? [value.category] : []),
    ...(typeof value.type === 'string' ? [value.type] : []),
  ];
  const result = new Set(explicit.map(mapCategory).filter((item): item is string => item !== undefined));
  if (result.size > 0) return result;
  const inferred = mapCategory(text(value, 'title', 'name', 'description', 'text', 'expectedOutcome', 'observableOutcome'));
  if (inferred !== undefined) result.add(inferred);
  return result;
}

function isCritical(value: Row): boolean {
  return value.critical === true
    || /^(P0|P1)$/i.test(String(value.priority ?? ''))
    || /high|critical/i.test(String(value.severity ?? value.risk ?? ''));
}

function criterionEvidence(criterion: Row, rtm: Row | undefined): string[] {
  return unique([...strings(criterion.evidenceIds), ...strings(rtm?.evidenceIds)]);
}

function rtmAcId(value: Row): string {
  return text(value, 'acId', 'acceptanceCriterionId', 'requirementId');
}

function rtmScenarioIds(value: Row): string[] {
  return unique([...strings(value.scenarioIds), ...strings(value.testScenarioIds)]);
}

function readinessEvidenceIds(readiness: Row): Set<string> {
  const result = new Set<string>();
  const visit = (value: unknown, key = ''): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item, key);
      return;
    }
    if (value === null || typeof value !== 'object') return;
    const current = value as Row;
    for (const evidenceId of strings(current.evidenceIds)) result.add(evidenceId);
    if (key === 'sources' || key === 'evidence') {
      const sourceId = text(current, 'id', 'evidenceId');
      if (sourceId) result.add(sourceId);
    }
    for (const [childKey, child] of Object.entries(current)) visit(child, childKey);
  };
  visit(readiness);
  return result;
}

function readinessText(readiness: Row): string {
  const values: string[] = [];
  const visit = (value: unknown): void => {
    if (typeof value === 'string') values.push(value.toLowerCase());
    else if (Array.isArray(value)) value.forEach(visit);
    else if (value !== null && typeof value === 'object') Object.values(value).forEach(visit);
  };
  visit(readiness);
  return values.join(' ');
}

function unresolved(items: Row[]): Row[] {
  return items.filter((item) => !/resolved|closed|complete|available|confirmed|approved/i.test(text(item, 'status', 'state')));
}

function containsFlakiness(value: unknown): boolean {
  if (typeof value === 'string') return /sleep\s*\(|wait\s+for\s+\d|random|current\s+time|eventually|settimeout/i.test(value);
  if (Array.isArray(value)) return value.some(containsFlakiness);
  if (value !== null && typeof value === 'object') return Object.values(value).some(containsFlakiness);
  return false;
}

/** Independently validate a test design before automation implementation. */
export function reviewTestDesign(value: unknown): TestDesignReview {
  const input = row(value);
  const readiness = row(input.readinessPackage ?? input.readiness);
  const design = row(input.design ?? input.testDesign);
  const criteria = rows(readiness.acceptanceCriteria ?? readiness.acs ?? readiness.requirements);
  const scenarios = rows(design.scenarios ?? design.testCases ?? design.cases);
  const readinessRtm = rows(readiness.rtm ?? readiness.requirementsTraceabilityMatrix ?? readiness.traceabilityMatrix ?? readiness.acVerificationMap);
  const designRtmValue = design.rtm ?? design.requirementsTraceabilityMatrix ?? design.traceabilityMatrix;
  const designRtm = rows(designRtmValue);
  const evidence = readinessEvidenceIds(readiness);
  const findings: TestDesignReviewFinding[] = [];
  const missingCoverage: string[] = [];

  const add = (
    category: TestDesignReviewFinding['category'],
    message: string,
    recommendation: string,
    scenarioIds: string[] = [],
    evidenceIds: string[] = [],
    severity: TestDesignReviewFinding['severity'] = 'blocking',
  ): void => {
    findings.push(TestDesignReviewFindingSchema.parse({
      category, message, recommendation, scenarioIds: unique(scenarioIds), evidenceIds: unique(evidenceIds), severity,
    }));
  };

  const seenScenarioIds = new Map<string, string[]>();
  scenarios.forEach((scenario, index) => {
    const scenarioId = id(scenario) || `scenario-${index + 1}`;
    seenScenarioIds.set(scenarioId, [...(seenScenarioIds.get(scenarioId) ?? []), scenarioId]);
  });
  for (const [scenarioId, ids] of seenScenarioIds) {
    if (ids.length > 1) add('duplicate', `Scenario ID '${scenarioId}' is duplicated.`, 'Give every scenario a unique stable ID.', ids);
  }

  const readinessBlockers = unresolved([
    ...rows(readiness.phaseSpecificBlockers),
    ...rows(readiness.blockers),
  ]);
  for (const blocker of readinessBlockers) add(
    'blocker',
    `Readiness blocker remains unresolved: ${text(blocker, 'description', 'summary', 'message') || 'unspecified blocker'}.`,
    'Resolve the blocker before implementation.',
    [],
    strings(blocker.evidenceIds),
  );

  if (readiness.readinessDecision && !/^(ready|ready-for-design)$/i.test(String(readiness.readinessDecision))) {
    add('blocker', `Readiness decision '${String(readiness.readinessDecision)}' does not permit test design implementation.`, 'Return to refinement and resolve the readiness decision.');
  }
  if (design.decision === 'waiting-for-human' || row(design.humanDecision).status === 'pending') {
    add('blocker', 'Test design is waiting for a human decision.', 'Resolve the pending design question before implementation.');
  }

  for (const [field, label] of [['storyKey', 'story'], ['revision', 'source revision'], ['traceId', 'trace'], ['component', 'component']] as const) {
    const readinessValue = text(readiness, field);
    const designValue = text(design, field);
    if (readinessValue && designValue && readinessValue !== designValue) {
      add('traceability', `Design ${label} '${designValue}' does not match readiness '${readinessValue}'.`, `Regenerate the design from readiness package ${readinessValue}.`);
    }
  }

  const criteriaIds = new Set(criteria.map((criterion) => criterionId(criterion)).filter(Boolean));
  const readinessRtmByAc = new Map(readinessRtm.map((item) => [rtmAcId(item), item]));
  const scenarioById = new Map(scenarios.map((scenario) => [id(scenario), scenario]));

  for (const scenario of scenarios) {
    const scenarioId = id(scenario);
    const mappedAcs = scenarioAcIds(scenario);
    const unknownAcs = mappedAcs.filter((acId) => !criteriaIds.has(acId));
    if (unknownAcs.length > 0) add('traceability', `Scenario '${scenarioId || 'unknown'}' references unknown acceptance criteria: ${unknownAcs.join(', ')}.`, 'Map the scenario only to acceptance criteria in the readiness package.', scenarioId ? [scenarioId] : [], scenarioEvidenceIds(scenario));
    const unknownEvidence = scenarioEvidenceIds(scenario).filter((evidenceId) => !evidence.has(evidenceId));
    if (unknownEvidence.length > 0) add('traceability', `Scenario '${scenarioId || 'unknown'}' cites unavailable evidence: ${unknownEvidence.join(', ')}.`, 'Cite evidence IDs from the readiness package.', scenarioId ? [scenarioId] : [], unknownEvidence);
    const assumptions = strings(scenario.assumptions);
    const availableText = readinessText(readiness);
    for (const assumption of assumptions) {
      if (!availableText.includes(assumption.toLowerCase())) add('assumption', `Scenario '${scenarioId || 'unknown'}' relies on unsupported assumption: ${assumption}.`, 'Replace the assumption with readiness evidence or an explicit prerequisite.', scenarioId ? [scenarioId] : [], scenarioEvidenceIds(scenario));
    }
    if (containsFlakiness(scenario)) add('flakiness', `Scenario '${scenarioId || 'unknown'}' contains a timing or nondeterminism risk.`, 'Use deterministic fixtures and event/state synchronization.', scenarioId ? [scenarioId] : [], scenarioEvidenceIds(scenario), 'warning');
  }

  for (const criterion of criteria) {
    const acId = criterionId(criterion);
    if (!acId) {
      add('traceability', 'An acceptance criterion has no stable ID.', 'Assign a stable acceptance criterion ID before implementation.', [], strings(criterion.evidenceIds));
      continue;
    }
    const rtm = readinessRtmByAc.get(acId);
    if (readinessRtm.length > 0 && rtm === undefined) add('traceability', `Acceptance criterion '${acId}' has no RTM row.`, 'Add an RTM row with observable outcome and evidence.', [], strings(criterion.evidenceIds));
    const mapped = scenarios.filter((scenario) => scenarioAcIds(scenario).includes(acId));
    const required = isCritical(criterion) ? ['positive', 'negative', 'boundary', 'error'] : ['positive'];
    for (const kind of required) {
      if (!mapped.some((scenario) => scenarioCategories(scenario).has(kind))) {
        missingCoverage.push(`${acId}:${kind}`);
        add('coverage', `Acceptance criterion '${acId}' lacks ${kind} coverage.`, `Add a ${kind} scenario mapped to ${acId}.`, mapped.map(id).filter(Boolean), criterionEvidence(criterion, rtm));
      }
    }
  }

  if (designRtmValue !== undefined) {
    const seenRtmIds = new Set<string>();
    for (const rowValue of designRtm) {
      const rtmId = id(rowValue);
      if (rtmId && seenRtmIds.has(rtmId)) add('duplicate', `Design RTM ID '${rtmId}' is duplicated.`, 'Give every design RTM row a unique stable ID.');
      if (rtmId) seenRtmIds.add(rtmId);
      const acId = rtmAcId(rowValue);
      if (!criteriaIds.has(acId)) add('traceability', `Design RTM row '${rtmId || 'unknown'}' references unknown acceptance criterion '${acId || 'missing'}'.`, 'Map every design RTM row to a readiness acceptance criterion.');
      const missingScenarioIds = rtmScenarioIds(rowValue).filter((scenarioId) => !scenarioById.has(scenarioId));
      if (missingScenarioIds.length > 0) add('traceability', `Design RTM row '${rtmId || 'unknown'}' references missing scenarios: ${missingScenarioIds.join(', ')}.`, 'Reference scenarios that exist in the design.');
      const unknownEvidence = strings(rowValue.evidenceIds).filter((evidenceId) => !evidence.has(evidenceId));
      if (unknownEvidence.length > 0) add('traceability', `Design RTM row '${rtmId || 'unknown'}' cites unavailable evidence: ${unknownEvidence.join(', ')}.`, 'Cite evidence IDs from the readiness package.', [], unknownEvidence);
    }
    for (const criterion of criteria) {
      const acId = id(criterion);
      if (acId && !designRtm.some((rowValue) => rtmAcId(rowValue) === acId)) add('traceability', `Design has no RTM row for acceptance criterion '${acId}'.`, 'Add a design RTM row linking the criterion, scenarios, and evidence.', [], criterionEvidence(criterion, readinessRtmByAc.get(acId)));
    }
  }

  const blocking = findings.filter((finding) => finding.severity === 'blocking').length;
  const warnings = findings.filter((finding) => finding.severity === 'warning').length;
  const score = Math.max(0, 100 - blocking * 25 - warnings * 10);
  const verdict = blocking > 0 ? 'reject' : warnings > 0 ? 'revise' : 'approve';
  return TestDesignReviewSchema.parse({
    verdict,
    score,
    findings,
    missingCoverage: unique(missingCoverage),
    nextStage: verdict === 'approve' ? 'implementation' : 'planning',
    reviewSummary: verdict === 'approve'
      ? 'Design is traceable and covers the required risk categories.'
      : `Design requires revision before implementation (${blocking} blocking, ${warnings} warning findings).`,
  });
}

export const reviewDesign = reviewTestDesign;
