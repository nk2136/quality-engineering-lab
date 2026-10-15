import { z } from 'zod';

export const DiscrepancyClassificationSchema = z.enum([
  'aligned',
  'extra',
  'missing',
  'conflict',
  'silent',
]);

export const CoverageCategorySchema = z.enum([
  'positive',
  'negative',
  'boundary',
  'data-validation',
  'error',
  'permission',
  'idempotency',
  'ordering',
  'recovery',
]);

const RecordSchema = z.object({}).passthrough();
const AcceptanceCriterionSchema = z.object({
  id: z.string().min(1),
  statement: z.string().min(1),
  evidenceIds: z.array(z.string().min(1)).optional(),
}).passthrough();

export const DiscrepancyAnalysisInputSchema = z.object({
  storyKey: z.string().min(1).optional(),
  traceId: z.string().min(1).optional(),
  revision: z.string().min(1),
  generatedAt: z.string().datetime().optional(),
  createdAt: z.string().datetime().optional(),
  acceptanceCriteria: z.array(AcceptanceCriterionSchema).min(1),
  implementation: z.array(RecordSchema).optional(),
  implementationEvidence: z.array(RecordSchema).optional(),
  existingCoverage: z.array(RecordSchema).optional(),
  existingTests: z.array(RecordSchema).optional(),
  observedBehavior: z.array(RecordSchema).optional(),
  observations: z.array(RecordSchema).optional(),
  evidence: z.array(RecordSchema).optional(),
}).passthrough();

export type DiscrepancyClassification = z.infer<typeof DiscrepancyClassificationSchema>;
export type CoverageCategory = z.infer<typeof CoverageCategorySchema>;

export interface DiscrepancyRow {
  readonly id: string;
  readonly acId?: string;
  readonly classification: DiscrepancyClassification;
  readonly status: DiscrepancyClassification;
  readonly description: string;
  readonly evidenceIds: readonly string[];
}

export interface CoverageRequirement {
  readonly id: string;
  readonly acId: string;
  readonly category: CoverageCategory;
  readonly required: boolean;
  readonly rationale: string;
}

export interface RequirementsTraceabilityRow {
  readonly id: string;
  readonly acId: string;
  readonly expectedBehavior: string;
  readonly observableOutcome: string;
  readonly verificationMethods: readonly string[];
  readonly evidenceIds: readonly string[];
}

export interface DiscrepancyAnalysisReport {
  readonly schemaVersion: '1.0';
  readonly artifactKind: 'discrepancy-analysis';
  readonly storyKey: string | undefined;
  readonly revision: string;
  readonly traceId: string | undefined;
  readonly generatedAt: string;
  readonly discrepancyRows: readonly DiscrepancyRow[];
  readonly discrepancies: readonly DiscrepancyRow[];
  readonly discrepancyReport: readonly DiscrepancyRow[];
  readonly coverageRequirements: readonly CoverageRequirement[];
  readonly rtm: readonly RequirementsTraceabilityRow[];
  readonly requirementsTraceabilityMatrix: readonly RequirementsTraceabilityRow[];
  readonly traceabilityMatrix: readonly RequirementsTraceabilityRow[];
  readonly acVerificationMap: readonly RequirementsTraceabilityRow[];
  readonly summary: Readonly<Record<DiscrepancyClassification, number>>;
  artifact?: {
    readonly id: string;
    readonly kind: 'requirement-analysis';
    readonly schemaVersion: '1.0';
    readonly traceId: string | undefined;
    readonly createdAt: string;
    readonly content: DiscrepancyAnalysisReport;
    readonly metadata: Readonly<Record<string, string>>;
  };
}

type Row = Record<string, unknown>;
type ParsedInput = z.infer<typeof DiscrepancyAnalysisInputSchema>;

const categories: readonly CoverageCategory[] = [
  'positive', 'negative', 'boundary', 'data-validation', 'error',
  'permission', 'idempotency', 'ordering', 'recovery',
];

function rows(value: unknown, ...keys: string[]): Row[] {
  if (!value || typeof value !== 'object') return [];
  const source = value as Row;
  return keys.flatMap((key) => {
    const found = source[key];
    return Array.isArray(found)
      ? found.filter((item): item is Row => RecordSchema.safeParse(item).success)
      : [];
  });
}

function text(item: Row): string {
  for (const key of ['observedOutcome', 'observableOutcome', 'observedBehavior', 'outcome', 'result', 'description', 'text', 'statement']) {
    if (typeof item[key] === 'string' && item[key].trim()) return item[key].trim();
  }
  return '';
}

function acId(item: Row): string | undefined {
  for (const key of ['acId', 'acceptanceCriterionId', 'requirementId']) {
    if (typeof item[key] === 'string' && item[key].trim()) return item[key].trim();
  }
  if (Array.isArray(item.acIds) && item.acIds.length === 1 && typeof item.acIds[0] === 'string') return item.acIds[0];
  return undefined;
}

function evidenceIds(item: Row): string[] {
  const ids = Array.isArray(item.evidenceIds) ? item.evidenceIds.filter((id): id is string => typeof id === 'string' && id.length > 0) : [];
  if (typeof item.id === 'string' && item.id.length > 0 && !ids.includes(item.id)) ids.push(item.id);
  return ids;
}

function explicitClassification(item: Row): DiscrepancyClassification | undefined {
  const value = item.classification ?? item.status;
  return DiscrepancyClassificationSchema.safeParse(value).success
    ? value as DiscrepancyClassification
    : undefined;
}

function matchingEvidence(input: ParsedInput, criterionId: string): Row[] {
  return [
    ...rows(input, 'existingCoverage', 'existingTests'),
    ...rows(input, 'observedBehavior', 'observations'),
    ...rows(input, 'evidence'),
  ].filter((item) => acId(item) === criterionId);
}

function matchingImplementation(input: ParsedInput, criterionId: string): Row[] {
  return [
    ...rows(input, 'implementation', 'implementationEvidence'),
  ].filter((item) => acId(item) === criterionId);
}

function classify(criterion: Row, observed: Row[], implementation: Row[]): DiscrepancyClassification {
  const explicit = [...observed, ...implementation].map(explicitClassification).find((value) => value !== undefined);
  if (explicit !== undefined) return explicit;
  if (observed.length === 0) return 'missing';
  const outcome = observed.map(text).join(' ').toLowerCase();
  if (!outcome || /\b(silent|not asserted|not observed|unknown|no assertion)\b/.test(outcome)) return 'silent';
  if (/\b(conflict|contradict|does not|not guaranteed|mismatch|disagree)\b/.test(outcome)) return 'conflict';
  return 'aligned';
}

function rowDescription(classification: DiscrepancyClassification, criterion: Row, observed: Row[], implementation: Row[]): string {
  if (observed.length > 0 && text(observed[0]!) !== '') return text(observed[0]!);
  if (implementation.length > 0 && text(implementation[0]!) !== '') return text(implementation[0]!);
  const statement = typeof criterion.statement === 'string' ? criterion.statement : 'Acceptance criterion';
  return classification === 'missing'
    ? `No existing observable coverage was found for ${statement}`
    : `No observable outcome was recorded for ${statement}`;
}

function allEvidenceIds(criterion: Row, observed: Row[], implementation: Row[]): string[] {
  const result = new Set<string>(Array.isArray(criterion.evidenceIds) ? criterion.evidenceIds.filter((id): id is string => typeof id === 'string') : []);
  for (const item of [...observed, ...implementation]) for (const id of evidenceIds(item)) result.add(id);
  return [...result];
}

function applies(category: CoverageCategory, statement: string): boolean {
  const value = statement.toLowerCase();
  if (category === 'positive' || category === 'negative') return true;
  const patterns: Record<Exclude<CoverageCategory, 'positive' | 'negative'>, RegExp> = {
    boundary: /\b(boundary|limit|max(?:imum)?|min(?:imum)?|zero|empty|null|length|range|first|last)\b/,
    'data-validation': /\b(valid|invalid|validation|format|field|input|value|required|schema)\b/,
    error: /\b(error|fail|reject|exception|timeout|unavailable|failure)\b/,
    permission: /\b(permission|role|access|authori[sz]|forbidden|unauthori[sz]|admin)\b/,
    idempotency: /\b(idempotent|duplicate|repeat|retry|exactly once)\b/,
    ordering: /\b(order|ordered|sequence|sort|first|last|before|after)\b/,
    recovery: /\b(recover|resume|retry|outage|rollback|restore)\b/,
  };
  return patterns[category].test(value);
}

function buildCoverage(acceptanceCriteria: readonly Row[]): CoverageRequirement[] {
  return acceptanceCriteria.flatMap((criterion, index) => {
    const criterionId = String(criterion.id);
    const statement = String(criterion.statement);
    return categories.map((category) => ({
      id: `COVERAGE-${String(index + 1).padStart(3, '0')}-${category}`,
      acId: criterionId,
      category,
      required: applies(category, statement),
      rationale: applies(category, statement)
        ? `${category} behavior is applicable to '${statement}'.`
        : `${category} behavior was not indicated by the acceptance criterion.`,
    }));
  });
}

function buildRtm(input: ParsedInput, acceptanceCriteria: readonly Row[]): RequirementsTraceabilityRow[] {
  return acceptanceCriteria.map((criterion, index) => {
    const criterionId = String(criterion.id);
    const observed = matchingEvidence(input, criterionId);
    const implementation = matchingImplementation(input, criterionId);
    const methods = observed.length > 0
      ? observed.map((item) => typeof item.id === 'string' ? item.id : `coverage-${criterionId}`)
      : [`Create observable test coverage for ${criterionId}.`];
    const outcome = observed.map(text).find((value) => value && !/^silent$/i.test(value))
      ?? `An observable result for ${criterionId} is asserted.`;
    return {
      id: `RTM-${String(index + 1).padStart(3, '0')}`,
      acId: criterionId,
      expectedBehavior: String(criterion.statement),
      observableOutcome: outcome,
      verificationMethods: [...new Set(methods)],
      evidenceIds: allEvidenceIds(criterion, observed, implementation),
    };
  });
}

function analyze(input: ParsedInput): DiscrepancyRow[] {
  const result: DiscrepancyRow[] = [];
  for (const [index, criterion] of input.acceptanceCriteria.entries()) {
    const id = String(criterion.id);
    const observed = matchingEvidence(input, id);
    const implementation = matchingImplementation(input, id);
    const classification = classify(criterion, observed, implementation);
    result.push({
      id: `DISCREPANCY-${String(index + 1).padStart(3, '0')}`,
      acId: id,
      classification,
      status: classification,
      description: rowDescription(classification, criterion, observed, implementation),
      evidenceIds: allEvidenceIds(criterion, observed, implementation),
    });
  }

  const mappedIds = new Set([...input.acceptanceCriteria].map((criterion) => String(criterion.id)));
  const coveredItems = [...rows(input, 'existingCoverage', 'existingTests'), ...rows(input, 'observedBehavior', 'observations')];
  const referencedIds = new Set(coveredItems.flatMap(evidenceIds));
  const extra = [...coveredItems,
    ...rows(input, 'evidence').filter((item) => {
      const source = typeof item.source === 'string' ? item.source.toLowerCase() : '';
      return typeof item.id === 'string' && !referencedIds.has(item.id) && (source === 'test' || source === 'ui' || item.description !== undefined);
    }),
  ]
    .filter((item) => acId(item) === undefined || !mappedIds.has(acId(item)!));
  for (const [index, item] of extra.entries()) {
    result.push({
      id: `DISCREPANCY-${String(input.acceptanceCriteria.length + index + 1).padStart(3, '0')}`,
      classification: 'extra',
      status: 'extra',
      description: text(item) || 'Observed behavior is not mapped to an acceptance criterion.',
      evidenceIds: evidenceIds(item),
    });
  }
  return result;
}

export function generateRequirementsTraceabilityMatrix(value: unknown): readonly RequirementsTraceabilityRow[] {
  const input = DiscrepancyAnalysisInputSchema.parse(value);
  return buildRtm(input, input.acceptanceCriteria);
}

export function buildDiscrepancyAnalysis(value: unknown): DiscrepancyAnalysisReport {
  const input = DiscrepancyAnalysisInputSchema.parse(value);
  const generatedAt = input.generatedAt ?? input.createdAt ?? new Date().toISOString();
  const discrepancyRows = analyze(input);
  const rtm = buildRtm(input, input.acceptanceCriteria);
  const coverageRequirements = buildCoverage(input.acceptanceCriteria);
  const summary = {
    aligned: discrepancyRows.filter((row) => row.classification === 'aligned').length,
    extra: discrepancyRows.filter((row) => row.classification === 'extra').length,
    missing: discrepancyRows.filter((row) => row.classification === 'missing').length,
    conflict: discrepancyRows.filter((row) => row.classification === 'conflict').length,
    silent: discrepancyRows.filter((row) => row.classification === 'silent').length,
  } satisfies Record<DiscrepancyClassification, number>;
  const report = {
    schemaVersion: '1.0' as const,
    artifactKind: 'discrepancy-analysis' as const,
    storyKey: input.storyKey,
    revision: input.revision,
    traceId: input.traceId,
    generatedAt,
    discrepancyRows,
    discrepancies: discrepancyRows,
    discrepancyReport: discrepancyRows,
    coverageRequirements,
    rtm,
    requirementsTraceabilityMatrix: rtm,
    traceabilityMatrix: rtm,
    acVerificationMap: rtm,
    summary,
  } as DiscrepancyAnalysisReport;
  const artifactId = `discrepancy-analysis:${input.storyKey ?? 'story'}:${input.revision}`;
  report.artifact = {
    id: artifactId,
    kind: 'requirement-analysis',
    schemaVersion: '1.0',
    traceId: input.traceId,
    createdAt: generatedAt,
    content: { ...report },
    metadata: {
      revision: input.revision,
      storyKey: input.storyKey ?? 'unknown',
      discrepancyCount: String(discrepancyRows.length),
    },
  };
  return report;
}

export const analyzeDiscrepancies = buildDiscrepancyAnalysis;
export const buildDiscrepancyReport = buildDiscrepancyAnalysis;
export const generateRtm = generateRequirementsTraceabilityMatrix;
