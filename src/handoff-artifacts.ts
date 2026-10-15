import {
  ArtifactRecordSchema,
  DuplicateRecordError,
  type ArtifactRecord,
  type ArtifactStore,
} from './contracts.js';
import { validateReadinessPackage } from './readiness-validator.js';
import type { ReadinessPackage } from './schemas.js';

export interface ReadinessHandoffArtifacts {
  discrepancyReport: ArtifactRecord;
  traceabilityMatrix: ArtifactRecord;
}

export interface PublishReadinessHandoffArtifactsOptions {
  createdAt?: string;
  now?: () => string;
  discrepancyReportId?: string;
  traceabilityMatrixId?: string;
}

function rowsOf(packageValue: ReadinessPackage) {
  return packageValue.discrepancyRows ?? packageValue.discrepancies ?? packageValue.discrepancyReport ?? [];
}

function rtmOf(packageValue: ReadinessPackage) {
  return packageValue.rtm ?? packageValue.requirementsTraceabilityMatrix ?? packageValue.traceabilityMatrix ?? [];
}

function artifactId(prefix: string, packageId: string): string {
  return packageId.startsWith('readiness:')
    ? `${prefix}:${packageId.slice('readiness:'.length)}`
    : `${prefix}:${packageId}`;
}

function linkageMetadata(packageValue: ReadinessPackage, role: string): Record<string, string> {
  return {
    artifactRole: role,
    traceId: packageValue.traceId,
    readinessPackageId: packageValue.packageId,
    readinessPackageRevision: packageValue.revision,
    packageRevision: packageValue.revision,
    revision: packageValue.revision,
    storyKey: packageValue.storyKey,
    component: packageValue.component,
  };
}

function timestamp(
  packageValue: ReadinessPackage,
  options: PublishReadinessHandoffArtifactsOptions | undefined,
): string {
  return options?.createdAt ?? options?.now?.() ?? packageValue.createdAt;
}

function samePublication(left: ArtifactRecord, right: ArtifactRecord): boolean {
  return left.traceId === right.traceId &&
    left.kind === right.kind &&
    JSON.stringify(left.content) === JSON.stringify(right.content) &&
    JSON.stringify(left.metadata) === JSON.stringify(right.metadata);
}

async function putIdempotently(store: ArtifactStore, artifact: ArtifactRecord): Promise<ArtifactRecord> {
  const existing = await store.get(artifact.id);
  if (existing !== undefined) {
    if (!samePublication(existing, artifact)) {
      throw new Error(`Artifact '${artifact.id}' already contains a different publication.`);
    }
    return existing;
  }

  try {
    await store.put(artifact);
  } catch (error) {
    if (!(error instanceof DuplicateRecordError)) throw error;
    const winner = await store.get(artifact.id);
    if (winner === undefined || !samePublication(winner, artifact)) {
      throw new Error(`Artifact '${artifact.id}' already contains a different publication.`);
    }
    return winner;
  }
  return artifact;
}

function buildArtifacts(
  packageValue: ReadinessPackage,
  options: PublishReadinessHandoffArtifactsOptions | undefined,
): ReadinessHandoffArtifacts {
  const createdAt = timestamp(packageValue, options);
  const metadata = (role: string) => linkageMetadata(packageValue, role);
  const reportRows = rowsOf(packageValue).map((row) => ({
    ...row,
    classification: row.classification ?? row.status,
  }));
  const reportId = options?.discrepancyReportId ?? artifactId('discrepancy', packageValue.packageId);
  const matrixId = options?.traceabilityMatrixId ?? artifactId('rtm', packageValue.packageId);

  return {
    discrepancyReport: ArtifactRecordSchema.parse({
      id: reportId,
      traceId: packageValue.traceId,
      kind: 'requirement-analysis',
      schemaVersion: '1.0',
      createdAt,
      content: {
        type: 'discrepancy-report',
        traceId: packageValue.traceId,
        storyKey: packageValue.storyKey,
        component: packageValue.component,
        readinessPackageId: packageValue.packageId,
        readinessPackageRevision: packageValue.revision,
        rows: reportRows,
        unresolvedBlockers: packageValue.phaseSpecificBlockers,
      },
      metadata: metadata('discrepancy-report'),
    }),
    traceabilityMatrix: ArtifactRecordSchema.parse({
      id: matrixId,
      traceId: packageValue.traceId,
      kind: 'requirement-analysis',
      schemaVersion: '1.0',
      createdAt,
      content: {
        type: 'traceability-matrix',
        traceId: packageValue.traceId,
        storyKey: packageValue.storyKey,
        component: packageValue.component,
        readinessPackageId: packageValue.packageId,
        readinessPackageRevision: packageValue.revision,
        rows: rtmOf(packageValue),
      },
      metadata: metadata('traceability-matrix'),
    }),
  };
}

/** Validate once, then publish both Phase A artifacts with deterministic IDs. */
export async function publishReadinessHandoffArtifacts(
  value: unknown,
  store: ArtifactStore,
  options?: PublishReadinessHandoffArtifactsOptions,
): Promise<ReadinessHandoffArtifacts> {
  const packageValue = validateReadinessPackage(value);
  const artifacts = buildArtifacts(packageValue, options);
  return {
    discrepancyReport: await putIdempotently(store, artifacts.discrepancyReport),
    traceabilityMatrix: await putIdempotently(store, artifacts.traceabilityMatrix),
  };
}

export const publishReadinessArtifacts = publishReadinessHandoffArtifacts;
export const publishHandoffArtifacts = publishReadinessHandoffArtifacts;
