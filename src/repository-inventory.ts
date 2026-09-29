import { z } from 'zod';

const FileSchema = z.object({
  path: z.string().min(1).regex(/^[^\\/]+(?:\/[^\\/]+)*$/),
  revision: z.string().regex(/^[0-9a-f]{40}$/),
  content: z.string(),
});

export const RepositoryCoverageRequestSchema = z.object({
  requirement: z.string().min(1),
  files: z.array(FileSchema).min(1).max(200),
});

export const InventoryEntrySchema = z.object({
  path: z.string(),
  revision: z.string(),
  kind: z.enum(['test', 'page-object', 'fixture', 'helper', 'api-client', 'source']),
});

export const CoverageAdviceSchema = z.object({
  decision: z.enum(['reuse-existing-test', 'extend-existing-test', 'insufficient-evidence']),
  targetPath: z.string().nullable(),
  inventory: z.array(InventoryEntrySchema),
  reasons: z.array(z.string()).min(1),
  blockers: z.array(z.string()),
  warnings: z.array(z.string()),
});

export type RepositoryCoverageRequest = z.infer<typeof RepositoryCoverageRequestSchema>;
export type InventoryEntry = z.infer<typeof InventoryEntrySchema>;
export type CoverageAdvice = z.infer<typeof CoverageAdviceSchema>;

function kind(path: string, content: string): InventoryEntry['kind'] {
  if (/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path)) return 'test';
  if (/fixture|test\.extend|beforeEach/.test(`${path}\n${content}`)) return 'fixture';
  if (/page(?:object)?|class\s+\w+Page\b/i.test(`${path}\n${content}`)) return 'page-object';
  if (/api|client|request/.test(path)) return 'api-client';
  if (/export\s+(?:async\s+)?function|export\s+const/.test(content)) return 'helper';
  return 'source';
}

function tokens(value: string): Set<string> {
  return new Set(value.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []);
}

function score(requirement: Set<string>, file: z.infer<typeof FileSchema>): number {
  const haystack = tokens(`${file.path}\n${file.content}`);
  let matches = 0;
  for (const token of requirement) if (haystack.has(token)) matches += 1;
  return requirement.size === 0 ? 0 : matches / requirement.size;
}

function hasBehaviorEvidence(content: string): boolean {
  return /\bexpect\s*\(|\bassert\b|\.(?:click|fill|goto|request)\s*\(/.test(content);
}

export class RepositoryCoverageAdvisor {
  advise(value: unknown): CoverageAdvice {
    const request = RepositoryCoverageRequestSchema.parse(value);
    const inventory = request.files.map((file) => ({ path: file.path, revision: file.revision, kind: kind(file.path, file.content) }));
    const requirement = tokens(request.requirement);
    const candidates = request.files
      .filter((file) => kind(file.path, file.content) === 'test')
      .map((file) => ({ file, score: score(requirement, file) }))
      .sort((left, right) => right.score - left.score || left.file.path.localeCompare(right.file.path));
    const best = candidates[0];
    const warnings = request.files.flatMap((file) => {
      const result: string[] = [];
      if (/waitForTimeout|setTimeout\(/.test(file.content)) result.push(`${file.path} uses an arbitrary wait.`);
      if (/nth\(\d+\)|\/\/.*\[\d+\]/.test(file.content)) result.push(`${file.path} uses a positional locator.`);
      return result;
    });

    if (best !== undefined && best.score === 1 && hasBehaviorEvidence(best.file.content)) {
      return { decision: 'reuse-existing-test', targetPath: best.file.path, inventory,
        reasons: [`${best.file.path} covers every requirement token.`], blockers: [], warnings };
    }
    if (best !== undefined && best.score >= 0.5) {
      if (!hasBehaviorEvidence(best.file.content)) {
        return { decision: 'insufficient-evidence', targetPath: null, inventory,
          reasons: [`${best.file.path} has requirement-word overlap but no exercised behavior evidence.`],
          blockers: ['The highest-overlap test has no observable assertion or interaction evidence.'], warnings };
      }
      return { decision: 'extend-existing-test', targetPath: best.file.path, inventory,
        reasons: [`${best.file.path} is the highest-overlap existing suite.`], blockers: [], warnings };
    }
    return { decision: 'insufficient-evidence', targetPath: null, inventory,
      reasons: ['No existing test has sufficient requirement overlap.'],
      blockers: ['Provide a pinned test or page-object manifest for the affected feature.'], warnings };
  }
}
