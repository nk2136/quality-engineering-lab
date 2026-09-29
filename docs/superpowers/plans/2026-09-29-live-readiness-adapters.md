# Live Readiness Adapters Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enforce exact Jira issue-key allowlists and add a credential-free policy composition layer for the existing read-only Jira and GitHub retrieval adapters.

**Architecture:** Provider transport and normalization stay in the existing adapter files. A single Jira allowlist check runs before authorization. One thin composition module keeps policy data separate from credential callbacks and delegates routing to `CompositeKnowledgeSource`.

**Tech Stack:** TypeScript 5.9, Node.js 22, Zod 4, Vitest 3

---

## File map

- Modify `src/jira-cloud.ts`: require and enforce a Jira issue-key allowlist before authorization or HTTP.
- Modify `tests/jira-cloud.test.ts`: prove rejected keys perform no credential or network access.
- Create `src/live-readiness-adapters.ts`: create a composite Jira/GitHub source from non-secret policy and separate runtime callbacks.
- Create `tests/live-readiness-adapters.test.ts`: mocked parity contracts and routing.
- Modify `docs/JIRA_READ_ONLY_ADAPTER.md` and `docs/GITHUB_READ_ONLY_ADAPTER.md`: document exact allowlists and credential separation.

### Task 1: Require exact Jira allowlists

**Files:**

- Modify: `tests/jira-cloud.test.ts`
- Modify: `src/jira-cloud.ts`

- [ ] **Step 1: Write a failing out-of-allowlist test**

Add a source with `allowedIssueKeys: ['QE-42']`, a counted credential callback, and a counted mock HTTP client. Assert `source.search({ ...query, text: 'QE-43' })` rejects with `Jira issue 'QE-43' is not in the configured allowlist.` and both counters remain zero.

- [ ] **Step 2: Run it and confirm red**

Run `npx vitest run tests/jira-cloud.test.ts`.

Expected: FAIL because `allowedIssueKeys` is not an accepted option.

- [ ] **Step 3: Implement the minimal guard**

Add mandatory `allowedIssueKeys: readonly string[]` to `JiraCloudKnowledgeSourceOptions`. Parse a non-empty array of `JiraIssueKeySchema`, reject duplicate values, and store a `ReadonlySet<string>`. After parsing `issueKey` but before `this.#authorization()`, throw `new Error(\`Jira issue '${issueKey}' is not in the configured allowlist.\`)` for a missing key. Update all existing Jira test source constructors with `allowedIssueKeys: ['QE-42']`.

- [ ] **Step 4: Verify green**

Run `npx vitest run tests/jira-cloud.test.ts`.

Expected: all Jira tests pass.

### Task 2: Compose non-secret policy

**Files:**

- Create: `tests/live-readiness-adapters.test.ts`
- Create: `src/live-readiness-adapters.ts`

- [ ] **Step 1: Write failing parity and routing tests**

Create tests that route an allowed Jira issue and an allowlisted GitHub file through mock clients with `{ method: 'GET', redirect: 'error' }`; reject a Jira key without invoking either its credential callback or HTTP client; and show provider-error messages omit `Bearer do-not-expose`.

- [ ] **Step 2: Run it and confirm red**

Run `npx vitest run tests/live-readiness-adapters.test.ts`.

Expected: FAIL because the composition module does not exist.

- [ ] **Step 3: Implement the composition module**

Create `src/live-readiness-adapters.ts`. Export `LiveReadinessAdapterPolicy`, containing only `jira: { baseUrl, allowedIssueKeys }` and `github: { repository, revision, paths }`; `LiveReadinessCredentialProviders`, containing optional Jira/GitHub callback functions; and `createLiveReadinessKnowledgeSource(policy, dependencies = {})`. Construct the two existing sources using policy and dependency callbacks/clients, then return `new CompositeKnowledgeSource({ jira, github })`. Do not read environment variables or add credential fields to policy.

- [ ] **Step 4: Verify green**

Run `npx vitest run tests/jira-cloud.test.ts tests/github-repository.test.ts tests/live-readiness-adapters.test.ts tests/knowledge-assembler.test.ts`.

Expected: all selected tests pass without network access.

### Task 3: Document and complete verification

**Files:**

- Modify: `docs/JIRA_READ_ONLY_ADAPTER.md`
- Modify: `docs/GITHUB_READ_ONLY_ADAPTER.md`

- [ ] **Step 1: Document the policy boundary**

Record that `allowedIssueKeys` is mandatory, exact, and checked before Jira credential resolution; GitHub's repository/full SHA/file manifest constitute its allowlist; and live-readiness policy never holds credentials because runtime callbacks stay outside agent-facing contexts.

- [ ] **Step 2: Run deterministic verification**

Run `npm run check`, then run `git diff --check`.

Expected: TypeScript and Vitest pass, and the diff check reports no whitespace errors.

- [ ] **Step 3: Commit**

Run `git add src/jira-cloud.ts src/live-readiness-adapters.ts tests/jira-cloud.test.ts tests/live-readiness-adapters.test.ts docs/JIRA_READ_ONLY_ADAPTER.md docs/GITHUB_READ_ONLY_ADAPTER.md` followed by `git commit -m "feat: add live readiness retrieval policy"`.
