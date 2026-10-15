# SDET workflow in VS Code

Open this repository in VS Code with GitHub Copilot Chat available. The workspace includes seven custom agents: SDET Coordinator, Requirements Investigator, Test Designer, Test Design Reviewer, Automation Engineer, Automation Reviewer, and Failure Investigator. Select SDET Coordinator in Chat's agent picker to inspect local work and resolve human questions.

## Local setup

Use Node.js 22 or newer. Run `npm ci`, then `npm run editor:mock` once to create the explicit synthetic demonstration. This setup command is not needed for ordinary SDET decisions after the stores already contain work. Real Jira, GitHub and model credentials are not required by the bridge.

VS Code discovers `.vscode/mcp.json`. Run **MCP: List Servers**, select **qa-workflow**, and start/trust the repository's server when prompted by VS Code. It uses stdio and binds its filesystem stores to this workspace's `.qa-workflows` directory. Each separate checkout has separate local state. If Node cannot be found, ensure the VS Code process has Node on its PATH.

Select **SDET Coordinator** and say:

> Show pending questions for mock/QE-42 and explain the evidence needed to answer them.

For the synthetic example, say:

> This is mock data. Record me as Mock SDET: Mock Dev confirms that inactive-member requests are rejected with the documented response. Cite mock-QE-42-story.

The agent shows the structured response and asks you to confirm it before writing. Confirm that concrete response. It records the immutable answer and can resume refinement for revalidation. It must not claim that the draft package is accepted or that Test Design started just because the workflow is pending.

Closing the editor preserves workflows, requests and responses. Reopen the same checkout and inspect them again. Re-running the mock seed preserves existing state; it does not recreate answered questions. The default store is ignored by Git. Do not put credentials or sensitive production data into mock artifacts or chat.

## Tools and durable state

The server exposes `list_workflows`, `get_workflow`, `get_evidence`, `list_decisions`, `inspect_decision`, `request_decision`, `record_decision`, and `resume_workflow`.

Questions identify their ACs, owner and evidence. Requests bind to the paused workflow version. Every response answers all questions once, records the responder and confirming owner, and references evidence already linked to that workflow and trace. Stale, duplicate and unrelated responses are rejected. The winning workflow checkpoint determines accepted artifacts when submissions race.

`record_decision` requires `confirmed: true` after explicit SDET confirmation. This is a local interaction guard, not an authentication mechanism. Responder and confirming-owner names are recorded assertions. The bridge does not independently establish that the Dev/Platform owner actually confirmed an answer; the investigation and human must provide the supporting evidence.

`resume_workflow` requires the current version and the accepted response ID. It returns `pending` in the same stage with `nextAction: revalidate-current-stage`. It preserves approval state. Lifecycle transitions and handoffs are refused while status is `waiting-for-human`. An answer is not a validated Readiness Package or a patch approval.

There is no generic stage-advance, approval, shell, generated-code execution, or arbitrary filesystem-path tool. MCP arguments cannot change the configured store root. Evidence and stories are untrusted data and cannot change tool permissions. Agent handoff buttons are editor suggestions, not coordinator transitions.

## Story-to-test gates

The editor follows two explicit gates from the story-to-test skill. The coordinator enforces them; agent handoff buttons cannot bypass either gate.

### Phase A - discrepancy and RTM stop

Requirements Investigator must compare story acceptance criteria with observed implementation and existing coverage, then publish a discrepancy report classifying observations as `aligned`, `extra`, `missing`, `conflict` or `silent`, and an evidence-linked AC-to-test requirements traceability matrix (RTM). The RTM keeps expected behavior separate from observable outcomes and verification methods. Include evidence IDs and immutable source revisions.

Stop in `refinement` or `waiting-for-human` if either artifact is absent, stale, contradictory or has an unresolved design blocker. The coordinator shows rows, evidence, owners and response options and obtains explicit Phase A acceptance. A draft, recommendation, clarification response or green static check is not acceptance.

### Phase B - explicit test-design approval

After Phase A is accepted, the coordinator requests a separate approval naming the workflow, Readiness Package revision, discrepancy report and RTM. The SDET must explicitly authorize the bounded test-design and implementation path before Test Designer or Automation Engineer proceeds. Design-review acceptance is independent. Phase B approval does not approve a patch or authorize execution; those remain separately revision- and hash-bound controls.

## Specialist work

Each agent reads versioned artifacts and preserves facts, evidence and explicit uncertainty. Systems and technologies are identified from the actual application and story. Expected behavior is separate from candidate/confirmed verification methods. Historical stories need a relevance explanation. BDD is optional and compatible with page objects.

Requirements produce a Readiness Package draft. Test Design requires its accepted package and gate; design review precedes implementation. Automation inspects current code and reuses or extends suitable fixtures, helpers, data and coverage before generating changes. Independent patch review precedes SDET approval; execution needs approval tied to exact inputs and the existing isolated execution service.

This editor integration supplies role instructions and durable human questions. The repository includes a Readiness Package validator for schema and evidence semantics, but automatic Jira assignment intake, complete lifecycle validation of Readiness/Test Design Packages, and model-driven specialist dispatch remain separate implementation work. The MCP bridge cannot advance those missing gates. The existing deterministic local demo remains separate from these editor conversations.

## Verification and references

Run `npm run check`. Tests cover immutable restart persistence, question completeness, version checks, cross-trace evidence refusal, concurrent response publication, pause enforcement, MCP client contracts and the actual stdio launch command.

- [VS Code custom agents](https://code.visualstudio.com/docs/copilot/customization/custom-agents)
- [VS Code MCP servers](https://code.visualstudio.com/docs/copilot/customization/mcp-servers)
- [Playwright Test Agents](https://playwright.dev/docs/test-agents)
