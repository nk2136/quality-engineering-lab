import { z } from 'zod';
import {
  RepositoryCoverageAdvisor,
  RepositoryCoverageRequestSchema,
  type InventoryEntry,
} from './repository-inventory.js';

const ScenarioSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  uiEvidence: z.boolean(),
});

export const CoverageMatrixRequestSchema = z.object({
  files: RepositoryCoverageRequestSchema.shape.files,
  scenarios: z.array(ScenarioSchema).min(1),
});

export const CoverageMatrixEntrySchema = z.object({
  id: z.string(),
  decision: z.enum(['reuse-existing-test', 'extend-existing-test', 'create-new-test', 'insufficient-evidence']),
  targetPath: z.string().nullable(),
  inventory: z.array(z.custom<InventoryEntry>()),
  reasons: z.array(z.string()).min(1),
  blockers: z.array(z.string()),
  warnings: z.array(z.string()),
});

export type CoverageMatrixEntry = z.infer<typeof CoverageMatrixEntrySchema>;

function slug(value: string): string {
  return (value.toLowerCase().match(/[a-z0-9]{2,}/g) ?? ['scenario']).join('-');
}

function testRoot(files: readonly { path: string }[]): string {
  return files.find((file) => /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file.path))?.path.split('/')[0] ?? 'tests';
}

export function buildCoverageMatrix(value: unknown): readonly CoverageMatrixEntry[] {
  const request = CoverageMatrixRequestSchema.parse(value);
  const advisor = new RepositoryCoverageAdvisor();
  return request.scenarios.map((scenario) => {
    const advice = advisor.advise({ requirement: scenario.text, files: request.files });
    if (advice.decision !== 'insufficient-evidence') return { id: scenario.id, ...advice };
    if (scenario.uiEvidence) {
      return {
        id: scenario.id,
        decision: 'create-new-test' as const,
        targetPath: `${testRoot(request.files)}/${slug(scenario.text)}.spec.ts`,
        inventory: advice.inventory,
        reasons: ['Verified UI evidence exists, but no existing suite overlaps this scenario.'],
        blockers: [],
        warnings: advice.warnings,
      };
    }
    return { id: scenario.id, ...advice };
  });
}
