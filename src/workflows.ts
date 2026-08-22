import { run } from '@openai/agents';
import { failureTriageAgent, requirementsAgent, testDesignerAgent, testReviewAgent } from './agents.js';
import { QaPlanSchema, type FailureTriage, type QaPlan } from './schemas.js';

function requireOutput<T>(value: T | undefined, agentName: string): T {
  if (value === undefined) {
    throw new Error(`${agentName} completed without a structured final output.`);
  }
  return value;
}

export async function createQaPlan(requirement: string): Promise<QaPlan> {
  const analysisRun = await run(requirementsAgent, requirement, { maxTurns: 4 });
  const analysis = requireOutput(analysisRun.finalOutput, requirementsAgent.name);

  const designRun = await run(
    testDesignerAgent,
    JSON.stringify({ requirement, analysis }),
    { maxTurns: 4 },
  );
  const design = requireOutput(designRun.finalOutput, testDesignerAgent.name);

  const reviewRun = await run(
    testReviewAgent,
    JSON.stringify({ requirement, analysis, design }),
    { maxTurns: 4 },
  );
  const agentReview = requireOutput(reviewRun.finalOutput, testReviewAgent.name);

  return QaPlanSchema.parse({
    schemaVersion: '1.0',
    createdAt: new Date().toISOString(),
    requirement,
    analysis,
    design,
    agentReview,
    humanReview: {
      status: 'pending',
      reviewer: null,
      reviewedAt: null,
      notes: 'Agent output is a draft until a human reviewer approves it.',
    },
  });
}

export async function triageFailure(evidence: unknown): Promise<FailureTriage> {
  const result = await run(failureTriageAgent, JSON.stringify(evidence), { maxTurns: 4 });
  return requireOutput(result.finalOutput, failureTriageAgent.name);
}
