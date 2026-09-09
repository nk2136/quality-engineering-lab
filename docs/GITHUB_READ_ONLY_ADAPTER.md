# Read-only GitHub repository adapter

`GitHubRepositoryKnowledgeSource` retrieves a small, explicitly configured set of UTF-8 files through GitHub's repository contents API. It is intended for architecture decisions, ownership metadata, API specifications, and relevant test files used by Story Readiness.

## Security and reproducibility boundaries

- The repository is fixed when the adapter is created.
- Every request uses a full 40- or 64-character Git object ID, never a mutable branch or tag.
- Only normalized, unique paths from a manifest of at most 50 files can be read.
- Requests use `GET`, reject redirects, enforce timeouts, and target `api.github.com` only.
- Authorization is injected at runtime and never enters model context or error messages.
- Files are limited to 1 MB, must be Base64-encoded UTF-8, and must match their declared byte size.
- Returned evidence uses a commit-pinned URI and the file blob ID as its revision.
- The adapter provides no discovery, code search, branch lookup, file write, pull request, or merge operation.

The adapter performs deterministic lexical ranking across the configured manifest. This is intentionally a bounded baseline; hybrid or embedding retrieval should replace it only after improving the Story Readiness retrieval evaluation corpus.

GitHub documents that the contents endpoint accepts a `ref`, returns Base64 file content, and needs only read-level Contents permission for fine-grained tokens and GitHub Apps: [REST API endpoints for repository contents](https://docs.github.com/en/rest/repos/contents?apiVersion=2026-03-10#get-repository-content).
