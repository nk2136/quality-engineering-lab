# Live Readiness Adapters Design

## Objective

Make the existing Jira Cloud and GitHub repository retrieval boundaries safe to configure for a live-readiness workflow. Both providers remain read-only, retrieve only explicitly authorized resources, and use runtime-only credentials that cannot enter agent-facing policy, evidence, or errors.

## Scope

This increment adds an exact Jira issue-key allowlist and a small composition layer for the two existing adapters. GitHub continues to use its existing fixed repository, immutable revision, and explicit file manifest as its allowlist.

It adds mocked-contract parity tests that prove the two adapters share the essential safety behavior: GET-only requests, rejected redirects, bounded timeouts, zero network calls outside the requested source or allowlist, and sanitized errors that omit authorization values.

## Architecture

`JiraCloudKnowledgeSource` receives `allowedIssueKeys` at construction. A Jira query must be an exact valid key and must appear in that set before the adapter obtains authorization or calls HTTP. This prevents a model-selected key from expanding the available Jira scope.

`GitHubRepositoryKnowledgeSource` remains unchanged in its fundamental policy: repository, commit SHA, and normalized file manifest are construction-time configuration. It never discovers repositories, branches, or paths.

`LiveReadinessKnowledgeSources` is a thin composition module. Its policy input contains no credential fields: Jira base URL and issue keys, plus GitHub repository, commit SHA, and paths. Credential providers are separate callbacks supplied to the concrete adapters at application wiring time. The module exposes the existing `KnowledgeSource` contract through `CompositeKnowledgeSource`.

## Security boundary

- Requests are limited to HTTPS Jira Cloud and `api.github.com` GET endpoints.
- Jira accepts only exact keys from its configured allowlist.
- GitHub accepts only an immutable SHA and declared normalized paths.
- Credential callbacks are invoked only after query/source/allowlist validation. They are not included in configuration, evidence, thrown error messages, or documentation examples.
- Existing redirect rejection, timeout limits, size limits, content validation, and error sanitization remain in force.
- No Jira or GitHub write, discovery, search, branch lookup, pull-request, or merge capability is added.

## Testing

Mock HTTP clients will test both adapters without real credentials or network access. The tests cover successful allowed retrieval, GET/redirect/timeout request shape, source gating, out-of-allowlist rejection without invoking HTTP or credential callbacks, and error sanitization. The composition test confirms that its policy configuration builds the same adapters and retains source-specific routing.

## Deliberate limits

This is not live credential deployment. Environment loading, secret storage, and authorization to access real tenant data stay outside the agent runtime and outside this repository's agent-facing APIs. Jira comments/JQL and GitHub discovery remain separate future capabilities requiring their own policy and contract tests.
