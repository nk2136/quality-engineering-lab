# Story-to-test operations runbook

This repository provides a deterministic, local story-to-test flow. It is an
evidence and approval workflow, not a live Jira, GitHub, CI, or deployment
integration. The acceptance fixture uses injected mock sources and synthetic
data; it never requires provider credentials.

## State and gates

1. **Assignment and refinement (Phase A).** Start an idempotent story run with
   its story key, trace ID, and pinned source revision. The requirements
   investigator reads only bounded, read-only adapters. It must produce
   acceptance criteria, evidence IDs, a component, an RTM, discrepancy rows,
   prerequisites, and explicit clarifications/blockers. A story with unresolved
   clarification or blocker remains `needs-refinement`/`blocked`.
2. **Design gate.** Build a test design only from a `ready` or
   `ready-for-design` package. The independent design review must approve AC
   coverage, traceability, and flakiness checks before implementation planning.
3. **Automation and review (Phase B).** Automation produces a test-only patch
   intent constrained by the project profile, pinned revision, allowlisted test
   paths, and synthetic data sources. The automation reviewer checks the exact
   diff for traceability, framework, bounds, credentials, and destructive
   operations. Rejection routes back to planning; unresolved human decisions
   stop at `waiting-for-human`.
4. **Approval and verification.** A named human approval is hash-bound to the
   requirement, evidence, revision, patch, and policy inputs. The local executor
   copies a fixture into a disposable directory, applies the approved diff, and
   runs a fixed argument-array command. Triage records success, assertion,
   compilation, infrastructure, or timeout evidence.
5. **Evidence handoff.** Publish a report containing every handoff ID, source
   revision, patch hash, reviewer, execution result, blockers, and limitations.
   Reports intentionally set `releaseAuthorized: false`; they do not merge,
   deploy, close defects, or write back to providers.

## Local acceptance check

Run the focused acceptance flow with:

```text
npx vitest run tests/acceptance/workflow-acceptance.test.ts
```

Run the full deterministic check with `npm run check`. The test is provider
agnostic and should remain runnable offline. If it fails, inspect the first
failed gate and preserve its artifact IDs rather than skipping the gate.

## Recovery and operating rules

- Resume from the last persisted artifact/revision; do not regenerate against a
  moving branch and then reuse an old approval.
- Any source revision, patch, requirement, or policy-input change invalidates
  the approval and requires a fresh review.
- Missing access, test data, or provider evidence is a human decision, not a
  reason to invent values or claim live readiness.
- Keep provider adapters read-only and allowlisted. Credentials, tokens, and
  secrets must stay outside model-visible context and test fixtures.
- Treat hosted CI, deployment, Jira, and GitHub status as external follow-up
  evidence. This local runbook does not claim those systems are connected.
