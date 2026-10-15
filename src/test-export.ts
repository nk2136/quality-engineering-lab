import { z } from 'zod';
import { VerificationEvidenceReportSchema, type VerificationEvidenceReport } from './evidence-report.js';
import { ProjectProfileSchema, type ProjectProfile } from './project-profile.js';
import { TestDesignSchema, type TestDesign } from './test-design.js';

/** Formats intentionally supported by this local, write-free export boundary. */
export const TestManagementExportFormatSchema = z.enum(['json', 'csv']);
export type TestManagementExportFormat = z.infer<typeof TestManagementExportFormatSchema>;

export const TestManagementExportDestinationSchema = z.enum(['local-file', 'artifact-store']);
export type TestManagementExportDestination = z.infer<typeof TestManagementExportDestinationSchema>;

const ConfirmationSchema = z.strictObject({
  confirmed: z.literal(true),
  confirmedBy: z.string().trim().min(1),
  confirmedAt: z.string().datetime(),
});

export const DestinationConfirmationSchema = z.strictObject({
  destination: TestManagementExportDestinationSchema,
  format: TestManagementExportFormatSchema,
  confirmed: z.literal(true),
  confirmedBy: z.string().trim().min(1),
  confirmedAt: z.string().datetime(),
});
export type DestinationConfirmation = z.infer<typeof DestinationConfirmationSchema>;

/**
 * Inputs are intentionally artifact-shaped. In particular, execution evidence
 * must be the verification report produced by the execution router; a design
 * or caller-provided status cannot stand in for a run.
 */
export const TestManagementExportRequestSchema = z.strictObject({
  profile: z.unknown(),
  design: z.unknown(),
  executionEvidence: z.unknown(),
  destinationConfirmation: DestinationConfirmationSchema,
  ownerConfirmation: ConfirmationSchema,
  designerConfirmation: ConfirmationSchema,
});
export type TestManagementExportRequest = z.input<typeof TestManagementExportRequestSchema>;

export const TestManagementExportMetadataSchema = z.strictObject({
  destination: TestManagementExportDestinationSchema,
  format: TestManagementExportFormatSchema,
  confirmed: z.literal(true),
  confirmedBy: z.string().min(1),
  confirmedAt: z.string().datetime(),
  ownerConfirmed: z.literal(true),
  designerConfirmed: z.literal(true),
  externalWrite: z.literal(false),
  destinationConfirmation: DestinationConfirmationSchema,
});
export type TestManagementExportMetadata = z.infer<typeof TestManagementExportMetadataSchema>;

export interface TestManagementExportResult {
  readonly format: TestManagementExportFormat;
  readonly destination: TestManagementExportDestination;
  readonly metadata: TestManagementExportMetadata;
  readonly content: string;
}

type ParsedRequest = {
  readonly profile: ProjectProfile;
  readonly design: TestDesign;
  readonly execution: VerificationEvidenceReport;
  readonly destinationConfirmation: DestinationConfirmation;
  readonly ownerConfirmation: z.infer<typeof ConfirmationSchema>;
  readonly designerConfirmation: z.infer<typeof ConfirmationSchema>;
};

function parseRequest(value: unknown): ParsedRequest {
  const request = TestManagementExportRequestSchema.parse(value);
  const profile = ProjectProfileSchema.parse(request.profile);
  const design = TestDesignSchema.parse(request.design);
  let execution: VerificationEvidenceReport;
  try {
    execution = VerificationEvidenceReportSchema.parse(request.executionEvidence);
  } catch (error) {
    throw new Error('Export requires execution evidence produced by the verification router.', { cause: error });
  }

  if (design.traceId !== execution.traceId || design.revision !== execution.revision) {
    throw new Error('Design and execution evidence must use the same trace ID and revision.');
  }
  // These markers are emitted by routeVerification and make it impossible for
  // a design-only payload to masquerade as an executed result.
  if (!execution.execution.some((item) => item.startsWith('exit-code:')) || execution.triage.length === 0) {
    throw new Error('Execution evidence must include observed command and triage evidence.');
  }

  const confirmation = request.destinationConfirmation;
  if (!profile.reportingExport.formats.includes(confirmation.format)) {
    throw new Error(`Export format '${confirmation.format}' is not enabled by the project profile.`);
  }
  if (!profile.reportingExport.destinations.includes(confirmation.destination)) {
    throw new Error(`Export destination '${confirmation.destination}' is not enabled by the project profile.`);
  }
  return { profile, design, execution, destinationConfirmation: confirmation, ownerConfirmation: request.ownerConfirmation, designerConfirmation: request.designerConfirmation };
}

function metadata(input: ParsedRequest): TestManagementExportMetadata {
  const destinationConfirmation = input.destinationConfirmation;
  return {
    destination: destinationConfirmation.destination,
    format: destinationConfirmation.format,
    confirmed: true,
    confirmedBy: destinationConfirmation.confirmedBy,
    confirmedAt: destinationConfirmation.confirmedAt,
    ownerConfirmed: input.ownerConfirmation.confirmed,
    designerConfirmed: input.designerConfirmation.confirmed,
    externalWrite: false,
    destinationConfirmation,
  };
}

function jsonContent(input: ParsedRequest, exportMetadata: TestManagementExportMetadata): string {
  const scenarios = [...input.design.scenarios].sort((left, right) => left.id.localeCompare(right.id));
  return `${JSON.stringify({
    schemaVersion: '1.0',
    artifactKind: 'test-management-export',
    storyKey: input.design.storyKey,
    traceId: input.design.traceId,
    revision: input.design.revision,
    component: input.design.component,
    designId: input.design.designId,
    executionReportId: input.execution.reportId,
    executionState: input.execution.state,
    executionClassification: input.execution.classification,
    scenarios,
    executionEvidence: input.execution,
    metadata: exportMetadata,
  }, null, 2)}\n`;
}

function csvCell(value: string | null): string {
  const text = value ?? '';
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function csvContent(input: ParsedRequest): string {
  const header = ['storyKey', 'designId', 'scenarioId', 'title', 'category', 'acceptanceCriteriaIds', 'evidenceIds', 'executionReportId', 'executionState', 'executionClassification'];
  const scenarios = [...input.design.scenarios].sort((left, right) => left.id.localeCompare(right.id));
  const rows = scenarios.map((scenario) => [
    input.design.storyKey,
    input.design.designId,
    scenario.id,
    scenario.title,
    scenario.category,
    scenario.acceptanceCriteriaIds.join(';'),
    scenario.evidenceIds.join(';'),
    input.execution.reportId,
    input.execution.state,
    input.execution.classification,
  ].map(csvCell).join(','));
  return `${[header.join(','), ...rows, ''].join('\n')}`;
}

/** Builds local JSON/CSV content only; it never writes to a destination. */
export function exportTestManagement(value: unknown): TestManagementExportResult {
  const input = parseRequest(value);
  const exportMetadata = metadata(input);
  const content = exportMetadata.format === 'json' ? jsonContent(input, exportMetadata) : csvContent(input);
  return { format: exportMetadata.format, destination: exportMetadata.destination, metadata: exportMetadata, content };
}

export const buildTestManagementExport = exportTestManagement;
export const createTestManagementExport = exportTestManagement;
