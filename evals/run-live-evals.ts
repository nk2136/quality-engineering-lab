import { readFile } from 'node:fs/promises';
import { createQaPlan } from '../src/workflows.js';

interface GoldenCase {
  id: string;
  requirement: string;
  expectedLayers: string[];
  expectedTerms: string[];
}

const cases = JSON.parse(await readFile(new URL('./golden-cases.json', import.meta.url), 'utf8')) as GoldenCase[];
let failures = 0;

for (const testCase of cases) {
  const plan = await createQaPlan(testCase.requirement);
  const layers = new Set(plan.design.testCases.map((item) => item.layer));
  const serialized = JSON.stringify(plan).toLowerCase();
  const missingLayers = testCase.expectedLayers.filter((layer) => !layers.has(layer as never));
  const missingTerms = testCase.expectedTerms.filter((term) => !serialized.includes(term.toLowerCase()));
  const passed = missingLayers.length === 0 && missingTerms.length === 0 && plan.agentReview.score >= 70;

  console.log(JSON.stringify({ id: testCase.id, passed, missingLayers, missingTerms, score: plan.agentReview.score }));
  if (!passed) failures += 1;
}

if (failures > 0) process.exit(1);
