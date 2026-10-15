import {
  ReadinessPackageSchema,
  type ReadinessPackage,
} from './schemas.js';

type CitedItem = { evidenceIds: readonly string[] };

function assertUnique(ids: readonly string[], label: string): void {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) throw new Error(`${label} '${id}' is duplicated.`);
    seen.add(id);
  }
}
function assertCitations(
  items: readonly CitedItem[],
  declaredEvidence: ReadonlySet<string>,
): void {
  for (const item of items) {
    assertUnique(item.evidenceIds, 'Evidence reference');
    for (const evidenceId of item.evidenceIds) {
      if (!declaredEvidence.has(evidenceId)) {
        throw new Error(`Evidence '${evidenceId}' is not declared in provenance.`);
      }
    }
  }
}

function asRows(packageValue: ReadinessPackage): NonNullable<ReadinessPackage['discrepancyRows']> {
  return packageValue.discrepancyRows ?? packageValue.discrepancies ?? packageValue.discrepancyReport ?? [];
}

function asRtm(packageValue: ReadinessPackage): NonNullable<ReadinessPackage['rtm']> {
  return packageValue.rtm ?? packageValue.requirementsTraceabilityMatrix ?? packageValue.traceabilityMatrix ?? [];
}

function decision(packageValue: ReadinessPackage): 'ready' | 'needs-refinement' | 'blocked' | 'not-ready' {
  const value = packageValue.readyForDesignDecision ?? packageValue.readinessDecision ?? packageValue.proposedReadinessDecision;
  if (value === 'ready-for-design') return 'ready';
  if (value === 'ready' || value === 'needs-refinement' || value === 'blocked' || value === 'not-ready') return value;
  throw new Error('A readiness package must include a design-readiness decision.');
}

/**
 * Parses and validates the semantic gates needed before test design can start.
 * Evidence remains a self-contained manifest: every claim must cite an ID from
 * the package provenance, while the package never treats a citation as proof
 * that the cited source is current or authoritative.
 */
export function validateReadinessPackage(value: unknown): ReadinessPackage {
  const packageValue = ReadinessPackageSchema.parse(value);
  const sourceIds = packageValue.provenance.sources.map((source) => source.id);
  const declaredEvidence = new Set<string>();

  assertUnique(sourceIds, 'ID');
  for (const source of packageValue.provenance.sources) {
    assertUnique(source.evidenceIds, `Evidence references for '${source.id}'`);
    for (const evidenceId of source.evidenceIds) {
      if (declaredEvidence.has(evidenceId)) throw new Error(`Evidence '${evidenceId}' is declared more than once.`);
    }
    for (const evidenceId of source.evidenceIds) declaredEvidence.add(evidenceId);
  }

  const acceptanceCriteria = packageValue.acceptanceCriteria;
  const acceptanceCriterionIds = acceptanceCriteria.map((criterion) => criterion.id);
  assertUnique(acceptanceCriterionIds, 'ID');
  assertCitations(acceptanceCriteria, declaredEvidence);
  assertCitations(packageValue.confirmedFacts, declaredEvidence);
  assertCitations(packageValue.historicalRelevance, declaredEvidence);
  assertCitations(packageValue.accessDataPrerequisites, declaredEvidence);
  assertCitations(packageValue.ownedClarifications, declaredEvidence);
  assertCitations(packageValue.phaseSpecificBlockers, declaredEvidence);

  const discrepancyRows = asRows(packageValue);
  assertUnique(discrepancyRows.map((row) => row.id), 'ID');
  assertCitations(discrepancyRows, declaredEvidence);
  const criteria = new Set(acceptanceCriterionIds);
  for (const row of discrepancyRows) {
    const classification = row.classification ?? row.status;
    if (row.acId !== undefined && !criteria.has(row.acId)) {
      throw new Error(`Discrepancy row '${row.id}' references unknown acceptance criterion '${row.acId}'.`);
    }
    if (classification === undefined) throw new Error(`Discrepancy row '${row.id}' has no classification.`);
  }

  const allRowIds = [
    ...sourceIds,
    ...acceptanceCriterionIds,
    ...packageValue.confirmedFacts.map((fact) => fact.id),
    ...packageValue.historicalRelevance.map((item) => item.id),
    ...packageValue.accessDataPrerequisites.map((item) => item.id),
    ...packageValue.ownedClarifications.map((item) => item.id),
    ...packageValue.phaseSpecificBlockers.map((item) => item.id),
    ...discrepancyRows.map((row) => row.id),
  ];
  assertUnique(allRowIds, 'ID');

  const rtmRows = asRtm(packageValue);
  assertUnique(rtmRows.map((row) => row.id), 'ID');
  assertCitations(rtmRows, declaredEvidence);
  const rtmMethodIds: string[] = [];
  for (const row of rtmRows) {
    if (!criteria.has(row.acId)) {
      throw new Error(`RTM row '${row.id}' references unknown acceptance criterion '${row.acId}'.`);
    }
    if (row.expectedBehavior.trim() === row.observableOutcome.trim()) {
      throw new Error(`RTM row '${row.id}' must separate expected behavior from observable outcome.`);
    }
    const rowMethodIds = row.verificationMethods
      .filter((method) => typeof method !== 'string')
      .map((method) => method.id);
    assertUnique(rowMethodIds, `Verification method for '${row.id}'`);
    rtmMethodIds.push(...rowMethodIds);
    for (const method of row.verificationMethods) {
      if (typeof method !== 'string') assertCitations([method], declaredEvidence);
    }
  }
  assertUnique(rtmMethodIds, 'ID');

  const mappings = packageValue.acVerificationMap ?? rtmRows.map((row) => ({
    acId: row.acId,
    expectedBehavior: row.expectedBehavior,
    observableOutcome: row.observableOutcome,
    verificationMethods: row.verificationMethods.filter((method): method is { id: string; evidenceIds: string[]; description: string; status: 'candidate' | 'confirmed' } => typeof method !== 'string'),
    evidenceIds: row.evidenceIds,
  }));
  const mappedCriterionIds = mappings.map((mapping) => mapping.acId);
  assertUnique(mappedCriterionIds, 'Verification mapping');
  assertCitations(mappings, declaredEvidence);

  const methodRowIds: string[] = [];
  for (const mapping of mappings) {
    if (!criteria.has(mapping.acId)) {
      throw new Error(`Verification mapping references unknown acceptance criterion '${mapping.acId}'.`);
    }
    if (mapping.expectedBehavior.trim() === mapping.observableOutcome.trim()) {
      throw new Error(
        `Acceptance criterion '${mapping.acId}' must separate expected behavior from observable outcome.`,
      );
    }
    assertUnique(
      mapping.verificationMethods.map((method) => method.id),
      `Verification method for '${mapping.acId}'`,
    );
    methodRowIds.push(...mapping.verificationMethods.map((method) => method.id));
    assertCitations(mapping.verificationMethods, declaredEvidence);
  }
  assertUnique(methodRowIds, 'ID');
  assertUnique([...allRowIds, ...rtmRows.map((row) => row.id), ...rtmMethodIds, ...methodRowIds], 'ID');

  for (const criterion of acceptanceCriteria) {
    const count = mappings.filter((mapping) => mapping.acId === criterion.id).length;
    if (count === 0) {
      throw new Error(`Acceptance criterion '${criterion.id}' has no verification mapping.`);
    }
  }

  const readinessDecision = decision(packageValue);
  const unresolvedDiscrepancy = discrepancyRows.some((row) => {
    const classification = row.classification ?? row.status;
    return classification === 'missing' || classification === 'conflict' || classification === 'silent';
  });

  if (readinessDecision === 'blocked' && packageValue.phaseSpecificBlockers.length === 0) {
    throw new Error('A blocked package must contain a phase-specific blocker.');
  }

  if (readinessDecision === 'ready') {
    if (packageValue.ownedClarifications.length > 0) {
      throw new Error('A ready-for-design package cannot contain owned clarifications.');
    }
    if (packageValue.phaseSpecificBlockers.length > 0) {
      throw new Error('A ready-for-design package cannot contain phase-specific blockers.');
    }
    const unavailable = packageValue.accessDataPrerequisites.filter(
      (prerequisite) => prerequisite.status !== 'available',
    );
    if (unavailable.length > 0) {
      throw new Error('A ready-for-design package cannot contain unavailable access or data prerequisites.');
    }
    if (unresolvedDiscrepancy) {
      throw new Error('A ready-for-design package cannot contain unresolved discrepancies.');
    }
  }

  return packageValue;
}

