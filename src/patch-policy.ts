import { z } from 'zod';

const RequestSchema = z.object({
  diff: z.string().min(1).max(100_000),
  allowlistedPaths: z.array(z.string().min(1)).min(1),
});

export interface PatchPolicyResult {
  readonly valid: boolean;
  readonly violations: readonly string[];
}

export function validatePatch(value: unknown): PatchPolicyResult {
  const { diff, allowlistedPaths } = RequestSchema.parse(value);
  const violations: string[] = [];
  for (const match of diff.matchAll(/^\+\+\+ b\/(.+)$/gm)) {
    const path = match[1]!;
    if (!allowlistedPaths.includes(path)) violations.push(`Path '${path}' is not allowlisted.`);
  }
  if (/waitForTimeout|setTimeout\(/.test(diff)) violations.push('Patch contains an arbitrary wait.');
  if (/\.nth\(\d+\)|\/\/.*\[\d+\]/.test(diff)) violations.push('Patch contains a positional locator.');
  if (/sk-[a-z]+-|api[_-]?key\s*=|BEGIN (?:RSA |OPENSSH )?PRIVATE KEY/i.test(diff)) {
    violations.push('Patch contains a possible secret.');
  }
  if (/package\.json|package-lock\.json/.test(diff)) violations.push('Patch changes dependencies.');
  if (/\.skip\(|\.only\(/.test(diff)) violations.push('Patch adds a focused or skipped test.');
  return { valid: violations.length === 0, violations };
}
