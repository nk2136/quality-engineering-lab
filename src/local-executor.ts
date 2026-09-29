import { spawn } from 'node:child_process';
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { isApprovalCurrent, type PatchApproval } from './patch-approval.js';
import { PatchReviewSchema } from './patch-review.js';
import { triageExecution, type ExecutionTriage } from './execution-triage.js';

const InputsSchema = z.object({ requirement: z.string(), evidence: z.string(), revision: z.string(), ui: z.string(), coverage: z.string(), patch: z.string(), policy: z.string() });
const InputSchema = z.object({
  approval: z.custom<PatchApproval>(),
  inputs: InputsSchema,
  sourceDirectory: z.string().min(1),
  command: z.array(z.string().min(1)).min(1).max(20),
  environment: z.record(z.string(), z.string()),
  review: PatchReviewSchema,
  timeoutMs: z.number().int().positive().max(60_000),
});

export interface LocalExecutionResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly triage: ExecutionTriage;
}

function environment(values: Readonly<Record<string, string>>): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ...values };
}

function run(command: readonly string[], cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<Omit<LocalExecutionResult, 'triage'>> {
  return new Promise((resolve, reject) => {
    const child = spawn(command[0]!, command.slice(1), { cwd, env, shell: false, windowsHide: true });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('close', (exitCode) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode, timedOut });
    });
  });
}

/** Copies the pinned fixture, applies the bound diff with Git, and runs fixed argument-array commands. */
export async function executeApprovedPatch(value: unknown): Promise<LocalExecutionResult> {
  const input = InputSchema.parse(value);
  if (!isApprovalCurrent(input.approval, input.inputs)) throw new Error('Patch approval is stale.');
  if (input.review.verdict !== 'accept') throw new Error('Patch review is not accepted.');
  const root = await mkdtemp(join(tmpdir(), 'qe-execution-'));
  try {
    const repository = join(root, 'repository');
    await cp(input.sourceDirectory, repository, { recursive: true });
    const patch = join(root, 'approved.patch');
    await writeFile(patch, input.inputs.patch, 'utf8');
    const env = environment(input.environment);
    const applied = await run(['git', 'apply', patch], repository, env, input.timeoutMs);
    if (applied.timedOut || applied.exitCode !== 0) {
      return { ...applied, triage: triageExecution(applied) };
    }
    const result = await run(input.command, repository, env, input.timeoutMs);
    return { ...result, triage: triageExecution(result) };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
