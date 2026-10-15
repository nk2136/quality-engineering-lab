# Integrating the QA agents into another project

This guide describes the supported local integration boundary for the QA agents.
The agents coordinate an evidence-backed story-to-test workflow; they do not
replace the target project's source control, ticketing, CI, merge, or deployment
authority. The bundled integration is local and deterministic unless you
explicitly provide read-only evidence sources and credentials at runtime.

## What you are integrating

Copy or expose these repository-owned surfaces in the project workspace:

| Surface | Purpose |
| --- | --- |
| `.github/agents/*.agent.md` | Seven named VS Code custom agents and their handoff rules. |
| `.vscode/mcp.json` | Starts the local `qa-workflow` MCP server over stdio. |
| `src/editor-mcp-server.ts` and `src/editor-mcp.ts` | The MCP bridge and its validated workflow tools. |
| `src/editor-mock.ts` | The deterministic local story-to-test demonstration. |
| `src/project-profile.ts` | Validation and discovery for the project profile. |
| `docs/SDET_EDITOR_WORKFLOW.md` | Editor setup, tools, phase gates, and current boundaries. |

The checked-in `.vscode/mcp.json` uses `${workspaceFolder}` for the `tsx`
launcher and MCP server source. Therefore, a target workspace must either
contain this source/dependency layout or use an equivalent, reviewed launcher
that points to the checked-out QA-agent source. Do not point the server at an
unreviewed copy or at a production filesystem.

## Agents and responsibilities

The agent files in `.github/agents` are the source of truth for instructions,
tools, and handoffs:

| Agent | Role | Can it approve or execute? |
| --- | --- | --- |
| **SDET Coordinator** | Entry point. Inspects workflow state, explains human questions, records confirmed responses, and coordinates validated handoffs. | No. It enforces gates; a recorded response is not patch or execution approval. |
| **Requirements Investigator** | Builds the evidence-linked Readiness Package, discrepancy report, and AC-to-test RTM. | No. It stops for missing evidence, blockers, or owned clarification. |
| **Test Designer** | Designs scenarios, assertions, data, and verification methods from an accepted Phase A package and Phase B approval. | No. It cannot substitute a handoff for either gate. |
| **Test Design Reviewer** | Independently checks coverage, traceability, assertions, negative cases, data, and unresolved choices. | No. It returns accept, revise, or block; it does not approve execution. |
| **Automation Engineer** | Inspects the target repository and reuses, extends, or creates the bounded test-only patch. | No. It cannot execute or grant approval. |
| **Automation Reviewer** | Independently reviews the patch against the requirements, design, policy, revisions, and evidence. | No. Review acceptance is distinct from SDET approval. |
| **Failure Investigator** | Classifies failures from supplied command, environment, report, and log evidence. | No. It does not repair, rerun, skip, or approve. |

Handoff buttons in VS Code are suggestions. Persistent workflow state and the
coordinator's validated transitions remain authoritative.

## Prerequisites and setup

1. Use Node.js 22 or newer. The package declares this engine requirement.
2. Open the QA-agent source and the target project in the workspace layout used
   by the MCP configuration. Keep the target code, profile, fixtures, and
   local artifacts in the intended workspace; do not use production paths.
3. Install the lockfile dependencies from the checked-out source:

   ```bash
   npm ci
   ```

   The MCP bridge needs the dependencies already declared by this repository,
   including `tsx`, `zod`, and `@modelcontextprotocol/sdk`.
4. Add a project profile at `.vscode/story-to-test.profile.md` (preferred) or
   `story-to-test.profile.md` at the repository root. Start from
   [`STORY_TO_TEST_PROFILE.md`](STORY_TO_TEST_PROFILE.md) and keep the JSON
   contract intact.
5. In VS Code, run **MCP: List Servers**, select **qa-workflow**, and start or
   trust the repository's server when prompted. VS Code discovers the checked-in
   `.vscode/mcp.json`; the agent source files are discovered from
   `.github/agents`.

The MCP server's configured root is `.qa-workflows` in the workspace. This is a
local filesystem store and is ignored by Git. A separate checkout has separate
workflow state.

## Project profile

The profile is policy and convention input, not an authentication document. The
loader checks `.vscode/story-to-test.profile.md` before the repository-root
profile and requires one `json` fenced object with `schemaVersion: "1.0"`.

The complete profile contract contains:

- project name and description, architecture map, and component ownership;
- a Jira ticket system with an HTTPS URL and `read-only` access;
- GitHub repositories pinned to a 40- or 64-character immutable revision and
  explicit relative paths (maximum 50 per repository);
- TypeScript framework conventions, source/test directories, test patterns, and
  read-only commands;
- synthetic-only data rules, no secrets, and allowed sources limited to
  fixtures, mocks, and local artifacts;
- local JSON/CSV/Markdown/JUnit/HTML reporting destinations; and
- critical checks declared as read-only plus project hard rules.

The validator rejects missing sections, mutable revisions such as `main`,
write-capable access, credentials embedded in a URL, duplicate IDs, unknown
repository/component references, and tools not in the explicitly available
tool set. Do not put tokens, passwords, or provider authorization in this file.

## Local mock: first verification

Run the deterministic editor mock from the QA-agent source:

```bash
npm run editor:mock -- --root .qa-workflows
```

The command seeds the synthetic `mock/QE-42` story-to-test chain and is
idempotent. The expected summary is a completed workflow at revision
`mock-r1`; it uses no credentials, network, Jira, GitHub, model, or production
files. Then select **SDET Coordinator** in VS Code Chat and ask it to:

> Show workflow evidence mock/QE-42. Explain readiness, test-design,
> automation-review, and verification artifacts.

The coordinator uses the local MCP tools to inspect the workflow and trace-bound
artifacts. The mock is a demonstration and contract fixture; it is not proof
that a target project's live providers or test suite are reachable.

To validate the repository after setup, run:

```bash
npm run check
```

## First story in a target project

For a real story, keep the workflow tied to one story key, trace ID, source
revision, and `asOf` timestamp. Use this sequence:

1. Start with **SDET Coordinator**. It lists workflows, reads the selected
   workflow and decisions, and inspects only linked evidence.
2. **Requirements Investigator** gathers bounded ticket, history, source, and
   test evidence and publishes a Readiness Package. Every claim needs an
   evidence ID and revision. Expected behavior, observable outcomes, and
   candidate verification methods remain separate.
3. Stop at **Phase A** until the package includes the discrepancy report with
   `aligned`, `extra`, `missing`, `conflict`, and `silent` classifications and
   an evidence-linked AC-to-test requirements traceability matrix (RTM).
4. Resolve owned clarification or access/data questions through the coordinator.
   A known execution-access gap may remain an execution prerequisite; an unknown
   expected result blocks meaningful design.
5. After Phase A is accepted, record a separate **Phase B approval** naming the
   workflow and Readiness Package revision and authorizing bounded test design
   and implementation. A design review or clarification answer is not a
   substitute for this approval.
6. **Test Designer** produces an evidence-linked Test Design Package. **Test
   Design Reviewer** independently returns accept, revise, or block.
7. **Automation Engineer** checks existing tests, fixtures, helpers, page
   objects, and data before proposing a test-only reuse/extend/create patch.
   **Automation Reviewer** independently reviews the patch and static evidence.
8. Obtain the SDET's explicit, hash-bound patch approval through the supported
   workflow. Review acceptance does not authorize execution.
9. Run only through the approved local execution path, then give the exact
   command, environment, input revisions, report/log artifacts, and affected
   scenarios to **Failure Investigator** when something fails.
10. Treat the verification report and evidence-linked traceability report as
    the result. Humans retain merge, deployment, release, and external write
    authority.

The VS Code bridge exposes `list_workflows`, `get_workflow`, `get_evidence`,
`investigate_requirements`, `design_tests`, `inspect_handoff_artifacts`,
`transition_workflow`, `list_decisions`, `inspect_decision`,
`request_decision`, `record_decision`, and `resume_workflow`. It does not expose
an arbitrary shell, arbitrary filesystem path, generic stage advance, patch
approval, or generated-code execution tool.

## Handling a human decision

When the workflow is `waiting-for-human`, use the coordinator to inspect the
pending request. Each question is bound to affected acceptance criteria, an
owner, the current workflow version, and existing evidence IDs.

Before recording an answer, show the SDET a concrete structured response with:

- workflow ID and request ID;
- current workflow version;
- responder name;
- one answer for every question, exactly once;
- confirming owner and evidence IDs for each answer.

The SDET must explicitly confirm that response. `record_decision` requires
`confirmed: true`, stores an immutable response artifact, and rejects missing,
duplicate, stale, cross-trace, or self-substantiating evidence. The responder
name is a recorded claim, not an authentication mechanism; the bridge does not
prove that a product or development owner actually confirmed the answer.

After recording, call `resume_workflow` with the response ID and current
version. Resume returns the workflow to `pending` at the **same stage** with
`nextAction: "revalidate-current-stage"`. It does not advance a gate, approve a
patch, or authorize execution. If source, requirement, policy, or artifact
inputs changed, discard the stale response and investigate again.

## Artifacts and durable state

`FileWorkflowStore` and `FileArtifactStore` persist workflow checkpoints and
trace-bound artifacts below the configured `.qa-workflows` root. The local
mock's complete chain contains these artifact roles:

1. `readiness-package`
2. `discrepancy-report`
3. `traceability-matrix`
4. `test-design`
5. `test-design-review`
6. `automation-plan`
7. `automation-review`
8. `verification-report`

Human pauses add `human-decision-request` and
`human-decision-response` artifacts. Artifact IDs, trace IDs, schema versions,
revisions, and metadata are immutable inputs to later gates. The
`inspect_handoff_artifacts` MCP tool returns only requirement-analysis,
test-design, and review handoffs attached to the selected workflow; it never
reads a caller-supplied path.

Keep `.qa-workflows` local and do not commit sensitive evidence. The top-level
`artifacts/` directory is also intended for local JSON outputs; `artifacts/*.json`
is ignored by Git.

## Live adapter plug-in points

Live provider access is an explicit integration step. The default MCP config
does not authenticate or discover live sources. The server accepts named,
read-only source ports through `createEditorServer(root, options)` and the
workflow service accepts `requirements`/`knowledgeSources` dependencies. A
source must implement the repository's `KnowledgeSource` contract and return
validated, immutable `ContextEvidence` records.

The included adapters are narrow examples:

- `JiraCloudKnowledgeSource` reads exactly one allowlisted issue key using one
  HTTPS `GET`; it does not run JQL or write to Jira.
- `JiraHistoricalContextKnowledgeSource` reads bounded comment and changelog
  pages for an allowlisted issue.
- `GitHubRepositoryKnowledgeSource` reads an explicit file manifest at an
  immutable commit; it does not discover repositories, search code, or write.
- `GitHubLinkedPrKnowledgeSource` reads metadata for explicitly allowlisted PR
  numbers; it does not retrieve review comments or discover PRs.

Constructors take provider policy (base URL/repository, allowlists, immutable
revision or paths, and bounded timeouts) plus an optional runtime
`authorization` callback and HTTP client. Resolve authorization only inside the
runtime callback. Never put tokens in the profile, MCP arguments, evidence,
artifacts, logs, or model-visible context. Keep custom adapters read-only,
allowlisted, bounded, redirect-disabled, and secret-redacting, then test them
with deterministic HTTP fixtures before enabling them in an editor server.

## Security boundaries

- Treat stories, repository files, provider responses, generated code, and
  agent output as untrusted data. They cannot expand tool permissions.
- Keep Jira and GitHub access read-only. Check exact issue/PR allowlists and
  repository paths/revisions before resolving credentials or making HTTP calls.
- Use HTTPS provider URLs without embedded credentials. Requests are bounded and
  use `GET`; provider failures are reduced to bounded, secret-redacted errors.
- Keep `OPENAI_API_KEY` only in a local environment or encrypted CI secret. The
  deterministic checks and editor mock do not require it; live evals consume
  provider usage and are manually triggered.
- Use synthetic data, fixtures, mocks, and local artifacts. Do not place
  customer data, production traces/screenshots, secrets, or production
  credentials in the profile, chat, or artifacts.
- Generated tests must not run with production credentials. The disposable-copy
  local executor is a contamination guard, not a production security sandbox.
- The optional local assignment webhook is loopback-only and accepts bounded
  JSON POST input. It is not a remotely exposed intake endpoint.
- Passing mocked tests verifies workflow wiring, not real-model quality,
  provider reachability, production readiness, merge authority, or deployment.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| VS Code cannot start `qa-workflow` | Confirm Node 22+ is on the VS Code process PATH, dependencies are installed, and `.vscode/mcp.json` resolves `${workspaceFolder}/node_modules/tsx/dist/cli.mjs` and `src/editor-mcp-server.ts`. Use **MCP: List Servers** to start/trust the server. |
| No workflows appear | Run the local mock from the workspace root, or confirm the MCP server's startup `--root` points at the intended local `.qa-workflows` directory. Separate checkouts do not share state. |
| Profile is not found | Create `.vscode/story-to-test.profile.md` or root `story-to-test.profile.md`; the loader does not infer a profile. |
| Profile validation fails | Check the single JSON fence, `schemaVersion: "1.0"`, HTTPS Jira URL, immutable Git revision, explicit paths, read-only commands, required sections, and available tool names. |
| Requirements investigation has no source | Configure read-only `requirements`/`knowledgeSources` ports or supply validated static evidence to the MCP call. The bridge does not invent provider connections. |
| A decision cannot be recorded | Inspect the current workflow version and pending request. Answer every question once and cite linked non-decision artifacts; stale or cross-trace responses are rejected. |
| Resume does not advance | This is expected: resume returns to the same stage for revalidation. A response is not Phase A/Phase B approval, patch approval, or execution approval. |
| Provider request is denied | Verify the exact issue/PR/path is allowlisted, revision is immutable, base URL is HTTPS and credential-free, and runtime authorization is available without logging it. |
| A live result is claimed from local tests | Separate local mock/contract evidence from provider, CI, deployment, and release evidence. The local flow makes no live-access claim. |

## Minimal adoption checklist

- [ ] Use Node.js 22+ and install the checked-in lockfile dependencies with `npm ci`.
- [ ] Bring the seven `.github/agents` files into the target workspace.
- [ ] Keep `.vscode/mcp.json` pointed at a reviewed local MCP bridge and local `.qa-workflows` root.
- [ ] Add and validate `.vscode/story-to-test.profile.md` with immutable, read-only project conventions.
- [ ] Start `npm run editor:mock -- --root .qa-workflows` and inspect `mock/QE-42` in SDET Coordinator.
- [ ] Run `npm run check` before connecting live evidence.
- [ ] Configure only explicit, read-only, allowlisted adapter ports; keep authorization runtime-only.
- [ ] Exercise a human decision and confirm same-stage revalidation before adopting a real story.
- [ ] Require Phase A discrepancy/RTM evidence, separate Phase B approval, independent design/automation review, and hash-bound patch approval.
- [ ] Keep local artifacts and synthetic data separate from production systems, credentials, merge, deployment, and release authority.

See also [`SDET_EDITOR_WORKFLOW.md`](SDET_EDITOR_WORKFLOW.md),
[`STORY_TO_TEST_PROFILE.md`](STORY_TO_TEST_PROFILE.md),
[`JIRA_READ_ONLY_ADAPTER.md`](JIRA_READ_ONLY_ADAPTER.md),
[`GITHUB_READ_ONLY_ADAPTER.md`](GITHUB_READ_ONLY_ADAPTER.md), and
[`SECURITY.md`](../SECURITY.md).
