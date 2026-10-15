# GitHub read-only adapters

`GitHubRepositoryKnowledgeSource` reads a fixed, normalized file manifest at
an immutable commit. `GitHubLinkedPrKnowledgeSource` is the separate historical
boundary for metadata on explicitly allowlisted pull requests.

## Shared security boundary

- Repository policy is explicit; the linked-PR adapter accepts only PR numbers
  in `allowedPrNumbers` (maximum 100, with no duplicates).
- Authorization is supplied through a runtime callback and never enters policy,
  evidence, or sanitized error messages.
- Requests target `api.github.com`, use `GET` only, reject redirects, and
  enforce a timeout capped at 60 seconds.
- No adapter performs discovery, code search, merge, or write operations.

## Repository adapter

Repository evidence is restricted to normalized paths (maximum 50), immutable
40- or 64-character Git object IDs, and UTF-8 files capped at 1 MiB. Returned
evidence uses the file blob SHA as its revision and applies deterministic
lexical ranking.

## Linked pull-request adapter

`GitHubLinkedPrKnowledgeSource` requests exactly
`GET /repos/{owner}/{repo}/pulls/{number}`. A query accepts only a positive PR
number (optionally prefixed with `#`) and must pass the explicit allowlist
before credentials or HTTP are resolved. Metadata is normalized to title,
body, state, draft/merge state, timestamps, author, labels, and head/base refs
and SHAs. The head SHA is used as the evidence revision, while the pull-request
URI remains tied to the configured repository and allowlisted number.

The returned `ContextEvidence` has an immutable payload for the retrieval and
provider errors are bounded and secret-redacted. This adapter deliberately
does not retrieve review comments or discover linked pull requests.

See [GitHub REST API pull requests](https://docs.github.com/en/rest/pulls/pulls#get-a-pull-request)
and [repository contents](https://docs.github.com/en/rest/repos/contents).
