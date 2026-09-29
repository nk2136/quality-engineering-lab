import { z } from 'zod';

const InputSchema = z.object({ timedOut: z.boolean(), exitCode: z.number().int().nullable(), stdout: z.string(), stderr: z.string() });
export const ExecutionTriageSchema = z.object({ category: z.enum(['success', 'timeout', 'assertion-failure', 'infrastructure-failure', 'compilation-failure']), evidence: z.string() });
export type ExecutionTriage = z.infer<typeof ExecutionTriageSchema>;

export function triageExecution(value: unknown): ExecutionTriage {
  const input = InputSchema.parse(value);
  const output = `${input.stdout}\n${input.stderr}`;
  if (input.timedOut) return { category: 'timeout', evidence: 'Process exceeded its execution timeout.' };
  if (input.exitCode === 0) return { category: 'success', evidence: 'Process exited with code 0.' };
  if (/AssertionError|expect\(/.test(output)) return { category: 'assertion-failure', evidence: output.slice(0, 500) };
  if (/ECONNREFUSED|ENOTFOUND|network|browser/i.test(output)) return { category: 'infrastructure-failure', evidence: output.slice(0, 500) };
  return { category: 'compilation-failure', evidence: output.slice(0, 500) };
}
