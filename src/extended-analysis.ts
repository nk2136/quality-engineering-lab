import { z } from 'zod';

const OperationSchema = z.object({ operationId: z.string().min(1), method: z.enum(['GET', 'POST', 'PUT', 'DELETE']), path: z.string().startsWith('/') });
const RunSchema = z.object({ testId: z.string().min(1), outcome: z.enum(['passed', 'failed']) });
const EventSchema = z.object({ traceId: z.string().min(1), message: z.string().min(1) });

export class MockOpenApiSource {
  readonly #operations: readonly z.infer<typeof OperationSchema>[];
  constructor(operations: readonly unknown[]) { this.#operations = z.array(OperationSchema).parse(operations); }
  operation(operationId: string) { return this.#operations.find((item) => item.operationId === operationId); }
}

export class MockPostgresSource {
  readonly #queries: Readonly<Record<string, readonly Record<string, unknown>[]>>;
  constructor(queries: Readonly<Record<string, readonly Record<string, unknown>[]>>) { this.#queries = queries; }
  query(name: string, limit: number): readonly Record<string, unknown>[] {
    if (!/^[a-z][a-z0-9_]*$/.test(name) || this.#queries[name] === undefined) throw new Error(`Query '${name}' is not declared.`);
    return this.#queries[name]!.slice(0, z.number().int().positive().max(100).parse(limit));
  }
}

export class MockCiSource {
  readonly #runs: readonly z.infer<typeof RunSchema>[];
  constructor(runs: readonly unknown[]) { this.#runs = z.array(RunSchema).parse(runs); }
  runs() { return this.#runs; }
}

export class MockTelemetrySource {
  readonly #events: readonly z.infer<typeof EventSchema>[];
  constructor(events: readonly unknown[]) { this.#events = z.array(EventSchema).parse(events); }
  events() { return this.#events; }
}

export function summarizeFlakiness(runs: readonly z.infer<typeof RunSchema>[]) {
  const byTest = new Map<string, z.infer<typeof RunSchema>[]>();
  for (const run of runs) byTest.set(run.testId, [...(byTest.get(run.testId) ?? []), run]);
  return [...byTest.entries()].flatMap(([testId, history]) => {
    const failures = history.filter(({ outcome }) => outcome === 'failed').length;
    return failures > 0 && failures < history.length ? [{ testId, sampleSize: history.length, failureRate: failures / history.length }] : [];
  });
}

export function draftDefects(items: readonly { signature: string; evidence: string }[]) {
  const grouped = new Map<string, string[]>();
  for (const item of items) grouped.set(item.signature, [...(grouped.get(item.signature) ?? []), item.evidence]);
  return [...grouped.entries()].map(([signature, evidence]) => ({ signature, occurrences: evidence.length, evidence }));
}

export function summarizeReleaseRisk(value: { blockers: readonly string[]; flaky: readonly unknown[]; defects: readonly unknown[] }) {
  const level = value.blockers.length > 0 || value.defects.length > 0 ? 'high' : value.flaky.length > 0 ? 'medium' : 'low';
  return { level, blockers: [...value.blockers], flakySignals: value.flaky.length, defectCount: value.defects.length, releaseAuthorized: false as const };
}
