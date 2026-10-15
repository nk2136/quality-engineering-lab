# Story-to-test project profile

`story-to-test.profile.md` is the explicit, repository-owned contract used by
the story-to-test workflow. Put it at `.vscode/story-to-test.profile.md` (the
preferred location) or at the repository root. The loader reads the first
location that exists; it does not infer architecture, tools, repositories, or
test conventions from the checkout.

The document contains a single JSON object in a `json` fenced block. The
contract is intentionally strict (`schemaVersion` is currently `1.0`). Jira
and GitHub access are read-only, code reads are pinned to an immutable commit,
and paths are an explicit allowlist. Credentials are never stored in this
file.

```json
{
  "schemaVersion": "1.0",
  "project": {
    "name": "Eligibility",
    "description": "Eligibility service checks."
  },
  "architectureMap": [
    {
      "componentId": "gateway",
      "responsibility": "Routes eligibility requests.",
      "dependsOn": []
    }
  ],
  "ticketSystem": {
    "provider": "jira",
    "baseUrl": "https://example.atlassian.net",
    "issueKeyPattern": "^[A-Z][A-Z0-9_]*-\\d+$",
    "accessMode": "read-only"
  },
  "components": [
    {
      "id": "gateway",
      "name": "Gateway",
      "responsibilities": ["Routes requests."],
      "repositoryIds": ["app"]
    }
  ],
  "repositories": [
    {
      "id": "app",
      "provider": "github",
      "repository": "acme/eligibility",
      "revision": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "paths": ["src", "tests"],
      "accessMode": "read-only"
    }
  ],
  "frameworkConventions": {
    "language": "typescript",
    "testRunner": "vitest",
    "testFilePatterns": ["tests/**/*.test.ts"],
    "sourceDirectory": "src",
    "testDirectory": "tests",
    "commands": [
      { "id": "typecheck", "command": "npm run typecheck", "tool": "npm", "readOnly": true }
    ]
  },
  "dataRules": {
    "syntheticDataOnly": true,
    "secretsAllowed": false,
    "forbiddenData": ["production records"],
    "allowedDataSources": ["fixtures", "mocks", "local-artifacts"]
  },
  "reportingExport": {
    "formats": ["json", "markdown"],
    "destinations": ["local-file", "artifact-store"]
  },
  "criticalChecks": [
    { "id": "tests", "command": "npm test -- --run", "tool": "npm", "readOnly": true }
  ],
  "hardRules": [
    "Use read-only provider access.",
    "Never use production data."
  ]
}
```

Use `loadProjectProfile(root)` or
`loadProjectProfileDocument(root)` from `src/project-profile.ts`. A caller can
pass `availableTools` to validation when the execution environment has a
smaller allowlist. An unknown or unavailable tool, missing section, mutable
revision, provider credential in a URL, or write-capable access mode fails
validation before any source adapter is called.

