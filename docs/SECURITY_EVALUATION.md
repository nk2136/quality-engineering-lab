# Security and local evaluation contract

The merged story-to-test workflow is evaluated locally with deterministic inputs. These checks are
security boundaries, not a claim that live Jira, GitHub, model, or deployment access is available.

| Boundary | Contract | Coverage |
| --- | --- | --- |
| Runtime secrets | Provider errors must not echo the authorization callback value; credentials remain runtime-only. | `tests/security-hardening.test.ts` — `redacts runtime authorization from provider error messages`; `tests/live-readiness-adapters.test.ts` |
| Allowlist before I/O | A Jira issue outside `allowedIssueKeys` fails before credential resolution or HTTP. | `tests/security-hardening.test.ts` — `checks the Jira allowlist before credentials and network I/O`; `tests/jira-cloud.test.ts` |
| Stale revisions | Human responses and resumes are bound to the paused workflow version and current stage; changed state requires revalidation. | `tests/human-decisions.test.ts` — stale response/resume cases |
| Trace binding | Evidence and handoff artifacts must belong to the workflow trace that consumes them. | `tests/security-hardening.test.ts` — cross-trace MCP read; `tests/human-decisions.test.ts`; `tests/editor-mcp.test.ts` |
| MCP confinement | The server root is selected at startup. Tool arguments cannot replace it or turn record IDs into filesystem paths. | `tests/security-hardening.test.ts` — root/path confinement; `tests/editor-mcp.test.ts` |
| Local mock acceptance | The complete artifact chain is reproducible, idempotent, synthetic, and requires no provider credentials or network. | `tests/security-hardening.test.ts`; `tests/editor-workflow-demo.test.ts` |

## Verification

Run the focused security/evaluation contract first:

```text
npm test -- tests/security-hardening.test.ts
```

Then run the repository gate:

```text
npm run check
```

The local mock command can also be exercised against a temporary root:

```text
npm run editor:mock -- --root .qa-workflows-security-eval
```

The mock writes only local workflow and artifact records. Remove that explicitly named temporary
directory after inspection; it is not a live-provider acceptance run.
