import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { approvePatch } from '../src/patch-approval.js';
import { executeApprovedPatch } from '../src/local-executor.js';

const roots: string[] = [];
const inputs = { requirement: 'r', evidence: 'e', revision: 'v', ui: 'u', coverage: 'c', patch: 'diff --git a/seed.txt b/seed.txt\n--- a/seed.txt\n+++ b/seed.txt\n@@ -1 +1 @@\n-before\n+after\n', policy: 'p' };

afterEach(async () => { await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

describe('local executor', () => {
  it('runs only a current approval in a disposable copy and captures output', async () => {
    const sourceDirectory = await mkdtemp(join(tmpdir(), 'qe-executor-source-'));
    roots.push(sourceDirectory);
    await writeFile(join(sourceDirectory, 'seed.txt'), 'before\n');
    const approval = approvePatch({ reviewer: 'Nikesh', approvedAt: '2026-09-29T12:00:00.000Z', inputs });

    const result = await executeApprovedPatch({
      approval, inputs, sourceDirectory,
      command: [process.execPath, '-e', 'process.stdout.write(require("fs").readFileSync("seed.txt", "utf8"))'],
      environment: { QE_EXECUTION: 'local-test' }, review: { verdict: 'accept', findings: [] }, timeoutMs: 5_000,
    });

    expect(result.triage.category).toBe('success');
    expect(result.stdout.replace(/\r\n/g, '\n')).toBe('after\n');
    expect(await readFile(join(sourceDirectory, 'seed.txt'), 'utf8')).toBe('before\n');
  });

  it('rejects stale approval before copying or running anything', async () => {
    await expect(executeApprovedPatch({
      approval: approvePatch({ reviewer: 'Nikesh', approvedAt: '2026-09-29T12:00:00.000Z', inputs }),
      inputs: { ...inputs, patch: 'changed' }, sourceDirectory: tmpdir(),
      command: [process.execPath, '-e', 'process.exit(0)'], environment: {}, review: { verdict: 'accept', findings: [] }, timeoutMs: 5_000,
    })).rejects.toThrow('approval is stale');
  });

  it('rejects a patch blocked by the independent reviewer', async () => {
    await expect(executeApprovedPatch({
      approval: approvePatch({ reviewer: 'Nikesh', approvedAt: '2026-09-29T12:00:00.000Z', inputs }),
      inputs, sourceDirectory: tmpdir(), command: [process.execPath, '-e', 'process.exit(0)'], environment: {},
      review: { verdict: 'block', findings: ['Patch contains an arbitrary wait.'] }, timeoutMs: 5_000,
    })).rejects.toThrow('not accepted');
  });

  it('retains assertion evidence when an approved test detects an intentional demo defect', async () => {
    const sourceDirectory = await mkdtemp(join(tmpdir(), 'qe-executor-defect-'));
    roots.push(sourceDirectory);
    await writeFile(join(sourceDirectory, 'seed.txt'), 'before\n');
    const approval = approvePatch({ reviewer: 'Nikesh', approvedAt: '2026-09-29T12:00:00.000Z', inputs });

    const result = await executeApprovedPatch({
      approval, inputs, sourceDirectory,
      command: [process.execPath, '-e', 'process.stderr.write("AssertionError: intentional demo defect"); process.exit(1)'],
      environment: {}, review: { verdict: 'accept', findings: [] }, timeoutMs: 5_000,
    });

    expect(result.triage).toMatchObject({ category: 'assertion-failure', evidence: expect.stringContaining('intentional demo defect') });
  });
});
