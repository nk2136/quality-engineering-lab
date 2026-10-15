# Jira read-only adapters

`JiraCloudKnowledgeSource` reads one exact, allowlisted issue with
`GET /rest/api/3/issue/{issueIdOrKey}`. `JiraHistoricalContextKnowledgeSource`
is the separate historical boundary for bounded comment and changelog pages.

## Shared security boundary

- Base URLs must use HTTPS and cannot contain credentials.
- Exact issue keys are checked against `allowedIssueKeys` before resolving the
  runtime authorization callback or making HTTP requests.
- Authorization is supplied through a runtime callback and never enters policy,
  evidence, or sanitized error messages.
- Requests are `GET` only, reject redirects, and enforce a timeout capped at
  60 seconds.
- Provider failures are reduced to bounded, secret-redacted messages.
- No adapter performs a Jira write or executes JQL.

## Issue adapter

The issue adapter normalizes summary, description, status, type, priority,
labels, components, fix versions, parent, and issue links into one immutable
`ContextEvidence` record. Atlassian Document Format descriptions are converted
to plain text. Its revision is Jira's `updated` value.

## Historical adapter

The historical adapter requests only the first bounded page for each endpoint:

- `/rest/api/3/issue/{key}/comment?startAt=0&maxResults={maxComments}`
- `/rest/api/3/issue/{key}/changelog?startAt=0&maxResults={maxChangelogEntries}`

Both limits are positive and capped at 100. The response is truncated to the
configured limits before normalization, and the resulting evidence revision is
the latest returned comment/changelog timestamp (or the query `asOf` value when
no entries are returned). Historical retrieval is intentionally not a
pagination or JQL discovery API.

See [Jira Cloud REST API v3](https://developer.atlassian.com/cloud/jira/platform/rest/v3/intro/)
and [Atlassian Document Format](https://developer.atlassian.com/cloud/jira/platform/apis/document/structure/).
