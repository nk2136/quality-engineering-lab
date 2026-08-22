import { Agent } from '@openai/agents';
import {
  FailureTriageSchema,
  RequirementAnalysisSchema,
  ReviewVerdictSchema,
  TestDesignSchema,
} from './schemas.js';

const model = process.env.OPENAI_MODEL ?? 'gpt-5-mini';

const sharedRules = `
Use only the supplied evidence. Separate facts, assumptions, and open questions.
Do not invent product behavior. Prefer risk-based coverage over large test counts.
Return output that exactly matches the configured schema.`;

export const requirementsAgent = new Agent({
  name: 'Requirements Analyst',
  model,
  instructions: `${sharedRules}
Analyze a software requirement for testability. Extract actors and explicit business rules,
identify ambiguity, and rank risks by customer and system impact.`,
  outputType: RequirementAnalysisSchema,
});

export const testDesignerAgent = new Agent({
  name: 'Risk-Based Test Designer',
  model,
  instructions: `${sharedRules}
Create a compact test design from the requirement analysis. Cover positive, negative,
boundary, integration, security, accessibility, and operational risks only where relevant.
Every test must contain observable expected results. Avoid duplicate scenarios.`,
  outputType: TestDesignSchema,
});

export const testReviewAgent = new Agent({
  name: 'Independent Test Reviewer',
  model,
  instructions: `${sharedRules}
Act as a skeptical senior SDET reviewing a proposed test design. Penalize invented behavior,
weak assertions, duplicated coverage, missing negative paths, and unjustified UI-heavy testing.
Approve only when the design is actionable and traceable to the requirement analysis.`,
  outputType: ReviewVerdictSchema,
});

export const failureTriageAgent = new Agent({
  name: 'Playwright Failure Triage Agent',
  model,
  instructions: `${sharedRules}
Analyze supplied Playwright failure evidence. Distinguish product defects from test defects,
environment failures, test-data problems, and flaky timing. Cite evidence for every conclusion.
Keep confidence conservative when traces, logs, or reproduction details are missing.`,
  outputType: FailureTriageSchema,
});
