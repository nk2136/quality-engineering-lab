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
    for (const evidenceId of item.evidenceIds) {
      if (!declaredEvidence.has(evidenceId)) {
        throw new Error(`Evidence '${evidenceId}' is not declared in provenance.`);
      }
    }
  }
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

  assertUnique(sourceIds, 'Provenance source');
  for (const source of packageValue.provenance.sources) {
    for (const evidenceId of source.evidenceIds) declaredEvidence.add(evidenceId);
  }

  const acceptanceCriteria = packageValue.acceptanceCriteria;
  const acceptanceCriterionIds = acceptanceCriteria.map((criterion) => criterion.id);
  assertUnique(acceptanceCriterionIds, 'Acceptance criterion');
  assertCitations(acceptanceCriteria, declaredEvidence);
  assertCitations(packageValue.confirmedFacts, declaredEvidence);
  assertCitations(packageValue.historicalRelevance, declaredEvidence);
  assertCitations(packageValue.accessDataPrerequisites, declaredEvidence);
  assertCitations(packageValue.ownedClarifications, declaredEvidence);
  assertCitations(packageValue.phaseSpecificBlockers, declaredEvidence);

  const mappings = packageValue.acVerificationMap;
  const mappedCriterionIds = mappings.map((mapping) => mapping.acId);
  assertUnique(mappedCriterionIds, 'Verification mapping');
  assertCitations(mappings, declaredEvidence);

  const criteria = new Set(acceptanceCriterionIds);
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
    assertCitations(mapping.verificationMethods, declaredEvidence);
  }

  for (const criterion of acceptanceCriteria) {
    const count = mappings.filter((mapping) => mapping.acId === criterion.id).length;
    if (count === 0) {
      throw new Error(`Acceptance criterion '${criterion.id}' has no verification mapping.`);
    }
  }

  if (packageValue.proposedReadinessDecision === 'ready') {
    if (packageValue.ownedClarifications.length > 0) {
      throw new Error('A ready package cannot contain owned clarifications.');
    }
    if (packageValue.phaseSpecificBlockers.length > 0) {
      throw new Error('A ready package cannot contain phase-specific blockers.');
    }
    const unavailable = packageValue.accessDataPrerequisites.filter(
      (prerequisite) => prerequisite.status !== 'available',
    );
    if (unavailable.length > 0) {
      throw new Error('A ready package cannot contain unavailable access or data prerequisites.');
    }
  }

  return packageValue;
}

