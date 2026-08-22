import { QaPlanSchema } from './schemas.js';
import { readJson, writeJson } from './io.js';

function valueAfter(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  const input = process.argv[2];
  const reviewer = valueAfter('--reviewer');
  const notes = valueAfter('--notes') ?? 'Reviewed and approved.';
  const output = valueAfter('--out') ?? 'artifacts/qa-plan.approved.json';

  if (!input || !reviewer) {
    throw new Error('Usage: npm run approve -- <draft.json> --reviewer "Name" [--notes "..."] [--out path]');
  }

  const draft = QaPlanSchema.parse(await readJson(input));
  if (draft.agentReview.verdict === 'reject') {
    throw new Error('The independent agent rejected this plan. Revise it before human approval.');
  }

  const approved = QaPlanSchema.parse({
    ...draft,
    humanReview: {
      status: 'approved',
      reviewer,
      reviewedAt: new Date().toISOString(),
      notes,
    },
  });

  await writeJson(output, approved);
  console.log(`Approved plan written to ${output}.`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
