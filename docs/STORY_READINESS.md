# Story Readiness contract

The first Phase 1 boundary converts a proposed analysis into a deterministic, auditable story-readiness assessment. It does not connect to Jira or invoke a model yet.

## Trust rules

- A finding must be based on selected `ContextPack` evidence, a documented contradiction, or an explicitly recorded missing fact.
- Evidence identifiers, contradictions, and missing facts are checked against the same context pack used for analysis.
- Finding IDs are unique, and every refinement question must resolve a known finding.
- The model cannot assign the readiness score or decision. The application calculates both from validated finding severities.
- Every assessment begins in `pending` human-review state. Jira write-back remains outside this boundary.

## Scoring

The assessment starts at 100 and deducts 5 points for a minor finding, 15 for a major finding, and 30 for a blocking finding. The score cannot fall below zero.

- Any blocking finding produces a `blocked` decision.
- With no major or blocking finding, a score of at least 80 is `ready`.
- Lower scores are `needs-refinement`.

The weights are intentionally simple and versioned with schema `1.0`. They provide a stable evaluation baseline and should be recalibrated only against human grooming verdicts.

## Read-only workflow

`runStoryReadinessWorkflow` is the first complete orchestration boundary. It:

1. Creates a trace-linked workflow record.
2. Queries a replaceable `KnowledgeSource` and builds a budgeted `ContextPack`.
3. Persists the context pack before model execution.
4. Calls `ModelGateway` with prompt version `story-readiness-v1`.
5. Rejects incomplete responses, mismatched story keys, invalid schemas, and citations outside the context pack.
6. Persists the validated assessment with provider, model, prompt, and token metadata.
7. Stops at `waiting-for-human` with approval pending.

Failures are recorded on the workflow, and any context artifact already created remains available for diagnosis. This workflow performs no Jira write-back; that remains a separate, approval-gated capability.
