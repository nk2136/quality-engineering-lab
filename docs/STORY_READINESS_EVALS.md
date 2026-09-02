# Story Readiness evaluations

The Story Readiness corpus is a human-authored baseline for measuring whether agent changes improve requirement analysis rather than merely produce valid JSON.

## Metrics

- **Decision agreement** checks the agent verdict against the human verdict.
- **Gap recall** matches expected gaps by category, severity, and required terms in the finding summary and impact.
- **Citation faithfulness** verifies that each finding uses evidence, missing facts, or contradictions allowed by the golden case.

Gap matching is one-to-one. A single broad finding cannot receive credit for multiple expected gaps. Cases with no expected gaps receive full recall, while unsupported extra findings reduce citation faithfulness.

Each case defines explicit pass thresholds. The initial corpus requires exact decision agreement, complete gap recall, and complete citation faithfulness. These strict thresholds are appropriate for the small baseline and can be recalibrated only from reviewed human judgments.

## Corpus coverage

`evals/story-readiness-cases.json` currently includes:

1. A ready story with explicit authorization behavior.
2. A story needing refinement because timeout behavior is missing.
3. A blocked story whose access requirement conflicts with a security decision record.

Each case contains sanitized source excerpts rather than citation identifiers alone. The deterministic test suite validates both the corpus and evaluator without calling a model. A later live runner can build context from these excerpts and feed model assessments into the same evaluator, preserving identical scoring between local comparisons and CI.
