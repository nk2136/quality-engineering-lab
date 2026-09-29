import { createQaPlan, triageFailure } from './workflows.js';
import { readJson, writeJson } from './io.js';
import { MockModelGateway } from './mock-model-gateway.js';
import { runLocalAutomationWorkflow } from './local-workflow.js';
import { z } from 'zod';

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function usage(): never {
  console.error(`Usage:
  npm run agent -- plan --requirement "<requirement>" [--out artifacts/qa-plan.json]
  npm run agent -- triage --report <playwright-report.json> [--out artifacts/triage.json]
  npm run agent -- workflow --input <workflow-input.json> [--out artifacts/workflow.json]`);
  process.exit(1);
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command === 'workflow') {
    const input = z.object({ mockDiff: z.string().min(1) }).passthrough().parse(
      await readJson(argument('--input') ?? usage()),
    );
    const output = argument('--out') ?? 'artifacts/workflow.json';
    const result = await runLocalAutomationWorkflow({
      ...input,
      gateway: new MockModelGateway([{ task: 'generate-code', output: { diff: input.mockDiff } }]),
    });
    await writeJson(output, result);
    console.log(`Local workflow result written to ${output}. Any patch still requires human approval.`);
    return;
  }

  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is required. Copy .env.example to .env and export the value securely.');
  }

  if (command === 'plan') {
    const requirement = argument('--requirement') ?? usage();
    const output = argument('--out') ?? 'artifacts/qa-plan.json';
    await writeJson(output, await createQaPlan(requirement));
    console.log(`Draft QA plan written to ${output}. Human approval is still required.`);
    return;
  }

  if (command === 'triage') {
    const report = argument('--report') ?? usage();
    const output = argument('--out') ?? 'artifacts/triage.json';
    await writeJson(output, await triageFailure(await readJson(report)));
    console.log(`Failure triage written to ${output}.`);
    return;
  }

  usage();
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
