# Complete Quality Engineering Platform Design

## Objective

Complete the quality-engineering platform locally with deterministic mock integrations and a demonstrable story-to-tested-automation workflow. Live Jira, GitHub, PostgreSQL, OpenAPI, CI, telemetry, and model data will connect through the same contracts when credentials and representative data are supplied.

The completed local system must analyze requirements and available evidence, inspect a UI and its existing automated tests, decide whether coverage should be reused or extended, generate a bounded Playwright patch when needed, obtain approval tied to exact inputs, execute the approved change locally, and publish an evidence-linked report. Broader quality capabilities—database validation, flaky-test analysis, defect drafting, and release-risk reporting—must operate against deterministic mock sources.

## Scope and delivery boundary

The first complete release targets one pinned TypeScript/Playwright repository and one local mock web application. It includes production-shaped interfaces and deterministic mock implementations for all external systems. It does not claim that a mock integration proves live-system compatibility; live validation begins after credentials, allowlists, and representative data are supplied.

Docker is not required. Approved tests run through a replaceable local executor in a disposable working copy with a fixed working directory, timeouts, resource-aware process termination, and an allowlisted environment. This limits accidental contamination but is not a security sandbox. Production use must provide a stronger isolated executor before running generated code against sensitive systems.

## Architecture

The existing contracts, context assembly, Story Readiness workflow, adapters, and in-memory stores remain the foundation. New behavior is added as a sequence of small workflow stages coordinated by a deterministic lifecycle coordinator. Each stage accepts immutable artifact references and emits a schema-validated, versioned artifact before the coordinator permits the next transition.

The coordinator owns state and policy. Specialist agents may recommend routing but cannot approve their own work, bypass a failed check, or declare execution successful without tool-produced evidence.

### Handoff sequence

1. Requirements Analyst
2. UI Discovery Agent
3. Repository Inventory Agent
4. Coverage Analysis Agent
5. Patch Generation Agent
6. Independent Patch Reviewer
7. Human Approval Gate
8. Local Execution and Failure Triage
9. Evidence Reporting and Release Risk

The coordinator may stop the sequence at coverage analysis when behavior is already adequately covered or when evidence is insufficient. It may also return a patch for bounded revision after review or human rejection. Retry exhaustion produces an explicit blocked or failed state.

## Lifecycle coordinator

The lifecycle coordinator provides:

- A declared transition table and terminal states.
- Filesystem-backed artifacts and workflow checkpoints using atomic replacement.
- Optimistic version checks and idempotency keys.
- Bounded retry counts for retryable stages.
- Cancellation checked before and after every handoff.
- Resume from the last schema-valid checkpoint.
- Rejection of duplicate runs and stale artifacts.
- Approval invalidation when the requirement, evidence revisions, repository revision, UI snapshot, or patch changes.
- Explicit failure records containing the failed stage, error category, attempted action, and retained diagnostic artifacts.

The durable store implements the existing `ArtifactStore` and `WorkflowStore` contracts. In-memory stores remain available for unit tests. No database or workflow framework is added for the local release.

## UI Discovery Agent

The UI Discovery Agent is a bounded evidence collector and handoff specialist. It receives:

- The requirement artifact and trace identifier.
- An authorized base URL and route allowlist.
- Allowed and prohibited action categories.
- An authentication-state reference, never raw credentials in model context.
- Context, page, interaction, and evidence budgets.

It may navigate the authorized local application, inspect accessibility and DOM state, populate reversible form inputs, and capture screenshots. Destructive actions are denied unless the workflow input explicitly authorizes the exact action.

Its output contains:

- Observed pages, dialogs, forms, navigation paths, and UI states.
- Interaction steps, preconditions, and required test data.
- Validation, error, permission, empty, loading, and success states.
- Ranked locator candidates and evidence that each candidate is unique.
- Positive, negative, boundary, and permission scenario observations.
- Requirement-to-UI contradictions.
- Missing evidence and blockers.
- References to screenshots and DOM or accessibility snapshots.

Locator ranking is:

1. Playwright role plus accessible name.
2. Associated label.
3. Stable test identifier.
4. Stable semantic text or attribute.
5. CSS selector as a reviewed fallback.

XPath and positional selectors fail policy validation unless a human explicitly accepts the documented fragility. The UI Discovery Agent cannot declare coverage complete, approve a patch, or authorize execution.

## Repository inventory and coverage analysis

Repository inventory runs at an immutable revision and records relevant tests, assertions, fixtures, helpers, page objects, API clients, configuration, and test commands. Parsed results cite file paths and revisions. Unsupported or ambiguous constructs are reported rather than inferred.

Coverage analysis joins requirements, UI evidence, repository inventory, and prior execution evidence. Each acceptance criterion receives one outcome:

- Already covered with cited evidence.
- Extend an existing test.
- Create a missing test.
- Stop because evidence, UI behavior, or test data is insufficient.
- Stop because the requirement contradicts observed behavior.

The coverage matrix distinguishes positive, negative, boundary, validation, permission, integration, accessibility, and recovery scenarios. Duplicate coverage is flagged only when it adds no distinct risk or test-layer value.

## Patch generation and review

Patch generation receives only the approved requirement, coverage decision, repository inventory, UI interaction map, locator map, and policy. It produces a bounded unified diff limited to allowlisted test and support paths. It must reuse existing fixtures, helpers, page objects, and conventions where suitable.

Static validation rejects patches that:

- Touch paths outside the allowlist.
- Add dependencies without explicit approval.
- Contain secrets or production endpoints.
- Use prohibited selectors or arbitrary waits.
- Introduce focused or skipped tests.
- Exceed configured file or line limits.
- Fail parsing, formatting, typechecking, or test discovery.

The independent reviewer checks requirement traceability, assertions, test data, locator stability, reuse, negative coverage, maintainability, and policy results. The reviewer emits accept, revise, or block with cited findings. It cannot grant human approval.

## Approval and execution

Approval records bind the reviewer identity and timestamp to cryptographic hashes of the requirement artifact, evidence manifest, repository revision, UI snapshot, coverage decision, patch, and execution policy. Any changed input invalidates approval.

The local executor creates a disposable copy of the pinned demo repository, applies only the approved patch, passes an allowlisted environment, runs fixed validation commands through argument arrays rather than shell interpolation, enforces timeouts, captures stdout and stderr, and terminates the process tree on timeout or cancellation. It never receives production credentials.

Execution evidence distinguishes compilation failure, infrastructure failure, assertion failure, application defect, flaky result, and successful completion. Failure triage must cite tool output and may recommend a repair; it cannot silently modify and rerun code beyond the coordinator's retry policy.

## Mock integrations and extended analysis

Each external system uses a narrow adapter with deterministic fixtures:

- Jira supplies stories, acceptance criteria, comments, and revisions.
- GitHub supplies a pinned manifest and file contents.
- OpenAPI supplies operations, schemas, and examples.
- PostgreSQL supplies allowlisted schema metadata and bounded read-only query results.
- CI supplies historical runs, logs, and artifacts.
- Telemetry supplies traces and structured log events.
- The model gateway supplies schema-valid responses and controlled failure modes.

Database validation accepts only named, predeclared read-only queries with row limits and timeouts. Defect drafting groups failures by normalized signature and supporting evidence. Flaky-test analysis compares deterministic run history and reports confidence plus sample size. Release-risk reporting summarizes requirement gaps, unreviewed changes, failed checks, flaky signals, and unresolved defects without granting deployment authority.

## Evidence report

The final report contains:

- Requirement and acceptance-criterion traceability.
- Source revisions and retrieval timestamps.
- UI workflows, states, screenshots, and locator evidence.
- Existing and proposed coverage by scenario category.
- Coverage decisions and reasons.
- Patch and independent-review results.
- Approval identity and bound hashes.
- Commands executed and exact tool outcomes.
- Failure classification, defect drafts, and flaky-test evidence.
- Release-risk summary, unresolved blockers, and limitations.

Reports are generated from stored artifacts rather than model recollection.

## Error handling

The workflow stops instead of guessing when evidence is missing, locator uniqueness cannot be established, UI and requirements conflict, authentication or test data is unavailable, a prohibited action is required, a source revision changes, approval becomes stale, or retry limits are exhausted.

Errors are classified as validation, policy, concurrency, integration, model, execution, timeout, cancellation, or evidence-staleness failures. Durable checkpoints retain all valid prior artifacts for diagnosis and resume.

## Verification strategy

Verification includes:

- Schema and contract unit tests.
- Transition, idempotency, cancellation, retry, resume, and crash-recovery tests.
- Mock-adapter contract tests for success, empty, malformed, stale, timeout, and authorization cases.
- UI discovery tests for unique and ambiguous locators, validation states, prohibited actions, and changed UI snapshots.
- Coverage-decision tests for reuse, extension, creation, contradiction, and insufficient evidence.
- Patch-policy and stale-approval tests.
- Local executor timeout, cancellation, environment, and output-capture tests.
- Flaky-test, defect-grouping, and release-risk tests.
- One local end-to-end demonstration in which the generated test detects an intentionally introduced application defect.
- A second end-to-end case that proves no new test is generated when behavior is already covered.

Completion requires TypeScript typechecking and all deterministic tests to pass without external credentials. Live validation is tracked separately and does not rewrite deterministic expected results.

## Aggressive delivery schedule

The prior September 25 milestone is obsolete. The local-mock completion target is **October 13, 2026**, assuming uninterrupted implementation and no expansion beyond this specification.

- September 29-30: durable coordinator, filesystem stores, lifecycle policy, resume and cancellation.
- October 1-2: demo application, UI Discovery Agent, locator evidence, repository inventory.
- October 5-6: coverage matrix, bounded patch generation, independent review.
- October 7-8: approval binding, local executor, failure triage, evidence report.
- October 9-12: remaining mock adapters, database validation, flaky analysis, defect drafting, release risk.
- October 13: end-to-end verification, documentation, roadmap reconciliation, and release candidate.

Live-integration dates begin after credentials, allowlists, representative data, and target environments are supplied. Each live adapter will first run read-only contract checks before joining the workflow.

## Completion criteria

The local project is complete when:

- Every stage above is reachable through a documented CLI workflow.
- All handoffs use schema-validated versioned artifacts.
- The workflow resumes after interruption and rejects duplicates and stale approval.
- UI discovery produces evidence-backed interaction and locator maps.
- Coverage analysis demonstrably chooses reuse, extension, creation, or stop.
- Only an approved patch can reach the executor.
- Both required end-to-end cases pass.
- Mock database, Jira, GitHub, OpenAPI, CI, telemetry, and model integrations pass contract tests.
- Evidence reports include all required traceability and risk sections.
- Security and mock-versus-live limitations are explicit.
- The README roadmap and status match verified behavior.
