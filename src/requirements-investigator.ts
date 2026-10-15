import { z } from 'zod';
import { ContextEvidenceSchema, type ContextEvidence } from './context.js';
import type { KnowledgeQuery, KnowledgeSource } from './contracts.js';
import { ReadinessPackageSchema, type ReadinessPackage } from './schemas.js';

const StoryKeySchema = z.string().regex(/^[A-Z][A-Z0-9_]*-\d+$/);

export const RequirementsInvestigationRequestSchema = z.object({
  traceId: z.string().uuid(),
  storyKey: StoryKeySchema,
  sourceRevision: z.string().trim().min(1),
  asOf: z.string().datetime(),
  component: z.string().trim().min(1).optional(),
  maxResults: z.number().int().positive().max(100).default(50),
});

export type RequirementsInvestigationRequest = z.input<typeof RequirementsInvestigationRequestSchema>;

/**
 * A source is intentionally just the existing read-only KnowledgeSource port.
 * The investigator never accepts a token, transport, or provider client.
 */
export interface RequirementsInvestigatorDependencies {
  readonly ticket: KnowledgeSource;
  readonly history: KnowledgeSource;
  readonly source: KnowledgeSource;
  readonly tests: KnowledgeSource;
}

export interface RequirementsInvestigationResult {
  readonly readinessPackage: ReadinessPackage;
}

export class RequirementsInvestigationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RequirementsInvestigationError';
  }
}

type JsonRecord = Record<string, unknown>;
type EvidenceSource = ContextEvidence['source'];

function record(content: string): JsonRecord {
  try {
    const parsed: unknown = JSON.parse(content);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as JsonRecord
      : {};
  } catch {
    return {};
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (typeof item === 'string' && item.trim() !== '') return [item.trim()];
    if (typeof item === 'object' && item !== null) {
      const entry = item as JsonRecord;
      const text = stringValue(entry.statement) ?? stringValue(entry.text) ?? stringValue(entry.summary);
      return text === undefined ? [] : [text];
    }
    return [];
  });
}

function textFromEvidence(item: ContextEvidence): string {
  const parsed = record(item.content);
  return [
    stringValue(parsed.summary),
    stringValue(parsed.description),
    item.content,
  ].filter((part): part is string => part !== undefined).join('\n');
}

function issueCriteria(item: ContextEvidence): string[] {
  const parsed = record(item.content);
  const explicit = stringArray(parsed.acceptanceCriteria);
  if (explicit.length > 0) return explicit;

  const lines = item.content.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return lines.flatMap((line) => {
    const match = /^(?:AC(?:CEPTANCE)?[-\s#]?\d*|[-*])\s*[:.)-]\s*(.+)$/i.exec(line);
    return match?.[1]?.trim() ? [match[1].trim()] : [];
  });
}

function tokens(value: string): Set<string> {
  return new Set(value.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []);
}

function overlaps(left: string, right: string): boolean {
  const expected = tokens(left);
  if (expected.size === 0) return false;
  const observed = tokens(right);
  let matched = 0;
  for (const token of expected) if (observed.has(token)) matched += 1;
  return matched / expected.size >= 0.5;
}

function query(
  request: z.infer<typeof RequirementsInvestigationRequestSchema>,
  text: string,
  source: EvidenceSource,
): KnowledgeQuery {
  return {
    traceId: request.traceId,
    text,
    sources: [source],
    maxResults: request.maxResults,
    asOf: request.asOf,
  };
}

async function read(
  adapter: KnowledgeSource,
  request: KnowledgeQuery,
  expectedSource: EvidenceSource,
): Promise<ContextEvidence[]> {
  const items = z.array(ContextEvidenceSchema).parse(await adapter.search(request));
  for (const item of items) {
    if (item.source !== expectedSource) {
      throw new RequirementsInvestigationError(
        `The ${expectedSource} adapter returned '${item.source}' evidence '${item.id}'.`,
      );
    }
  }
  return [...items].sort((left, right) => left.id.localeCompare(right.id));
}

function uniqueEvidence(items: readonly ContextEvidence[]): ContextEvidence[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

function sourceComponent(items: readonly ContextEvidence[]): string | undefined {
  for (const item of items) {
    const parsed = record(item.content);
    const component = stringValue(parsed.component);
    if (component !== undefined) return component;
    const components = stringArray(parsed.components);
    if (components[0] !== undefined) return components[0];
  }
  return undefined;
}

function sourceBranch(items: readonly ContextEvidence[]): string | undefined {
  return items.map((item) => stringValue(record(item.content).branch)).find(Boolean);
}

function sourceFiles(items: readonly ContextEvidence[]): string[] {
  return items.flatMap((item) => stringArray(record(item.content).files));
}

function isAmbiguous(statement: string): boolean {
  return /\b(?:TBD|TBC|as needed|as appropriate|appropriate|etc\.?|fast|quick|soon|reasonable)\b/i.test(statement);
}

function historyStatement(item: ContextEvidence): { statement: string; relevance: string } {
  const parsed = record(item.content);
  const statement = stringValue(parsed.summary) ?? stringValue(parsed.description) ?? item.content.slice(0, 500);
  const relevance = stringValue(parsed.relevance)
    ?? 'Historical behavior informs context only; it does not override the current story.';
  return { statement, relevance };
}

function sourceRevisionMismatch(
  source: readonly ContextEvidence[],
  expectedRevision: string,
): ContextEvidence | undefined {
  return source.find((item) => {
    if (item.revision === expectedRevision || item.uri.includes(expectedRevision)) return false;
    return stringValue(record(item.content).revision) !== expectedRevision;
  });
}

/**
 * Produces a readiness-package draft from four independently injected,
 * read-only evidence ports. No adapter credentials or network clients cross
 * this boundary; all claims retain the IDs of the evidence that supports them.
 */
export class RequirementsInvestigator {
  readonly #dependencies: RequirementsInvestigatorDependencies;

  constructor(dependencies: RequirementsInvestigatorDependencies) {
    this.#dependencies = dependencies;
  }

  async investigate(inputValue: RequirementsInvestigationRequest): Promise<RequirementsInvestigationResult> {
    const input = RequirementsInvestigationRequestSchema.parse(inputValue);
    const [ticket, history, source, tests] = await Promise.all([
      read(this.#dependencies.ticket, query(input, input.storyKey, 'jira'), 'jira'),
      read(this.#dependencies.history, query(input, `${input.storyKey} history`, 'jira'), 'jira'),
      read(this.#dependencies.source, query(input, `${input.storyKey} ${input.component ?? ''}`.trim(), 'github'), 'github'),
      read(this.#dependencies.tests, query(input, input.storyKey, 'test'), 'test'),
    ]);

    const allEvidence = uniqueEvidence([...ticket, ...history, ...source, ...tests]);
    const primaryTicket = ticket[0];
    if (primaryTicket === undefined) {
      throw new RequirementsInvestigationError(`No Jira evidence was returned for story '${input.storyKey}'.`);
    }

    const criteria = issueCriteria(primaryTicket);
    const ticketDetails = record(primaryTicket.content);
    const component = input.component ?? sourceComponent(source) ?? stringValue(ticketDetails.component) ?? 'unresolved-component';
    const branch = sourceBranch(source);
    const files = sourceFiles(source);
    const blockers: Array<{
      id: string;
      phase: string;
      description: string;
      evidenceIds: string[];
    }> = [];
    const clarifications: Array<{
      id: string;
      question: string;
      owner: string;
      evidenceIds: string[];
    }> = [];

    if (criteria.length === 0) {
      criteria.push('Acceptance criteria are unavailable in the ticket; obtain the expected behavior before design.');
      clarifications.push({
        id: 'QUESTION-1',
        question: 'What are the numbered acceptance criteria for this story?',
        owner: 'product',
        evidenceIds: [primaryTicket.id],
      });
      blockers.push({
        id: 'BLOCKER-1',
        phase: 'refinement',
        description: 'The ticket does not contain an acceptance criterion that can be asserted.',
        evidenceIds: [primaryTicket.id],
      });
    }

    criteria.forEach((statement, index) => {
      if (isAmbiguous(statement) && !clarifications.some((item) => item.question.includes(`AC-${index + 1}`))) {
        clarifications.push({
          id: `QUESTION-${clarifications.length + 1}`,
          question: `What measurable expected outcome should AC-${index + 1} '${statement}' require?`,
          owner: 'product',
          evidenceIds: [primaryTicket.id],
        });
      }
    });

    if (source.length === 0) {
      blockers.push({
        id: `BLOCKER-${blockers.length + 1}`,
        phase: 'refinement',
        description: 'No implementation source evidence was retrieved at the pinned revision.',
        evidenceIds: [primaryTicket.id],
      });
    }
    const staleSource = sourceRevisionMismatch(source, input.sourceRevision);
    if (staleSource !== undefined) {
      blockers.push({
        id: `BLOCKER-${blockers.length + 1}`,
        phase: 'refinement',
        description: `Implementation evidence revision '${staleSource.revision}' does not match pinned source revision '${input.sourceRevision}'.`,
        evidenceIds: [staleSource.id],
      });
    }
    if (component === 'unresolved-component') {
      blockers.push({
        id: `BLOCKER-${blockers.length + 1}`,
        phase: 'refinement',
        description: 'The affected component cannot be selected from the supplied evidence.',
        evidenceIds: [primaryTicket.id],
      });
    }

    const historicalRelevance = history.length === 0
      ? [{
          id: 'HISTORY-1',
          statement: 'No historical story or implementation evidence was retrieved.',
          relevance: 'No prior behavior is available to establish historical relevance.',
          evidenceIds: [primaryTicket.id],
        }]
      : history.map((item, index) => {
          const explanation = historyStatement(item);
          return {
            id: `HISTORY-${index + 1}`,
            statement: explanation.statement,
            relevance: explanation.relevance,
            evidenceIds: [item.id],
          };
        });

    const acceptanceCriteria = criteria.map((statement, index) => ({
      id: `AC-${index + 1}`,
      statement,
      evidenceIds: [primaryTicket.id],
    }));
    const sourceEvidenceIds = source.map((item) => item.id);
    const testEvidenceIds = tests.map((item) => item.id);

    const confirmedFacts = [
      {
        id: 'FACT-1',
        statement: `Story '${input.storyKey}' is '${stringValue(ticketDetails.summary) ?? primaryTicket.content.slice(0, 200)}'.`,
        evidenceIds: [primaryTicket.id],
      },
      {
        id: 'FACT-2',
        statement: `Selected component: ${component}.`,
        evidenceIds: sourceEvidenceIds.length > 0 ? sourceEvidenceIds : [primaryTicket.id],
      },
      {
        id: 'FACT-3',
        statement: `Pinned source revision: ${input.sourceRevision}${branch === undefined ? '' : ` on branch '${branch}'`}.`,
        evidenceIds: sourceEvidenceIds.length > 0 ? sourceEvidenceIds : [primaryTicket.id],
      },
      ...(files.length === 0 ? [] : [{
        id: 'FACT-4',
        statement: `Implementation files identified: ${files.join(', ')}.`,
        evidenceIds: sourceEvidenceIds,
      }]),
    ];

    const acVerificationMap = acceptanceCriteria.map((criterion, index) => {
      const matchingTests = tests.filter((item) => overlaps(criterion.statement, textFromEvidence(item)));
      const methodId = `METHOD-${index + 1}`;
      const hasCoverage = matchingTests.length > 0;
      const evidenceIds = hasCoverage ? matchingTests.map((item) => item.id) : [criterion.evidenceIds[0]!];
      return {
        acId: criterion.id,
        expectedBehavior: criterion.statement,
        observableOutcome: hasCoverage
          ? `Existing test evidence '${matchingTests[0]!.id}' exercises an observable outcome for ${criterion.id}.`
          : `An observable outcome for ${criterion.id} must be asserted at a system boundary.`,
        verificationMethods: [{
          id: methodId,
          description: hasCoverage
            ? `Review the existing test evidence for ${criterion.id}.`
            : `Add a test with an observable assertion for ${criterion.id}.`,
          status: hasCoverage ? 'confirmed' as const : 'candidate' as const,
          evidenceIds,
        }],
        evidenceIds: [...criterion.evidenceIds, ...evidenceIds.filter((id) => !criterion.evidenceIds.includes(id))],
      };
    });

    const discrepancyRows = acceptanceCriteria.map((criterion, index) => {
      const matchingTests = tests.filter((item) => overlaps(criterion.statement, textFromEvidence(item)));
      const classification = matchingTests.length > 0
        ? 'aligned' as const
        : source.length === 0 ? 'missing' as const : 'silent' as const;
      return {
        id: `DISCREPANCY-${index + 1}`,
        acId: criterion.id,
        classification,
        description: matchingTests.length > 0
          ? `${criterion.id} has matching existing test evidence.`
          : `${criterion.id} has no matching existing test evidence at the pinned source revision.`,
        evidenceIds: [...criterion.evidenceIds, ...(matchingTests.length > 0 ? matchingTests.map((item) => item.id) : sourceEvidenceIds)],
      };
    });

    const rtm = acVerificationMap.map((mapping, index) => ({
      id: `RTM-${index + 1}`,
      acId: mapping.acId,
      expectedBehavior: mapping.expectedBehavior,
      observableOutcome: mapping.observableOutcome,
      verificationMethods: mapping.verificationMethods.map((method) => method.id),
      evidenceIds: mapping.evidenceIds,
    }));

    const accessDataPrerequisites = [
      {
        id: 'PREREQ-1',
        description: 'Read-only implementation and test evidence at the pinned revision.',
        status: source.length > 0 && tests.length > 0 ? 'available' as const : 'unknown' as const,
        evidenceIds: source.length > 0 ? sourceEvidenceIds : [primaryTicket.id],
      },
    ];

    const decision = blockers.length > 0
      ? 'blocked' as const
      : clarifications.length > 0 || discrepancyRows.some((row) => row.classification !== 'aligned')
        ? 'needs-refinement' as const
        : 'ready' as const;

    const readinessPackage = ReadinessPackageSchema.parse({
      schemaVersion: '1.0',
      packageId: `readiness:${input.storyKey}:${input.sourceRevision}`,
      revision: input.sourceRevision,
      component,
      traceId: input.traceId,
      storyKey: input.storyKey,
      createdAt: input.asOf,
      provenance: {
        sources: allEvidence.map((item) => ({
          id: item.id,
          source: item.source,
          revision: item.revision,
          evidenceIds: [item.id],
        })),
      },
      acceptanceCriteria,
      confirmedFacts,
      historicalRelevance,
      discrepancyRows,
      rtm,
      acVerificationMap,
      accessDataPrerequisites,
      ownedClarifications: clarifications,
      phaseSpecificBlockers: blockers,
      proposedReadinessDecision: decision,
      readinessDecision: decision,
    });

    return { readinessPackage };
  }
}

export async function investigateRequirements(
  input: RequirementsInvestigationRequest,
  dependencies: RequirementsInvestigatorDependencies,
): Promise<RequirementsInvestigationResult> {
  return new RequirementsInvestigator(dependencies).investigate(input);
}
