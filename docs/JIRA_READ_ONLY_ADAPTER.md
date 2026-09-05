# Jira Cloud read-only adapter

`JiraCloudKnowledgeSource` is the first Jira integration boundary. It implements `KnowledgeSource` for one exact Jira issue key and performs only `GET /rest/api/3/issue/{issueIdOrKey}`.

## Security boundary

- The base URL must use HTTPS and cannot contain credentials.
- Authorization is supplied at runtime through a callback and is never included in evidence or error messages.
- Redirects are rejected to prevent an authorization header from being forwarded to another origin.
- Requests have a configurable timeout capped at 60 seconds.
- Broad text is rejected instead of being converted into uncontrolled JQL.
- Jira errors are reduced to status and sanitized API messages.

## Normalization

The adapter requests only fields needed for initial refinement: summary, description, update revision, status, issue type, priority, labels, components, fix versions, parent, and issue links. Jira descriptions use Atlassian Document Format, so the adapter walks the ordered node tree and converts supported text, mention, emoji, line-break, and inline-card nodes to plain text.

The normalized issue becomes one immutable `ContextEvidence` record. Its revision is Jira's `updated` value, and its retrieval time comes from the workflow query for deterministic replay.

## Deliberate limits

This increment does not retrieve comments, attachments, changelog history, Confluence pages, or execute JQL. Those are paginated and permission-sensitive capabilities that should be introduced behind separate tests and retrieval budgets. No Jira write operation exists in this adapter.

References: [Jira Cloud REST API v3](https://developer.atlassian.com/cloud/jira/platform/rest/v3/intro/) and [Atlassian Document Format](https://developer.atlassian.com/cloud/jira/platform/apis/document/structure/).
