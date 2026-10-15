# Example story-to-test profile

This is a local example profile. Replace values with repository-reviewed
conventions before using it; do not add credentials or provider write access.

```yaml
profileVersion: "1.0"
codeAccessMode: read-only
frameworkConventions:
  testRunner: vitest
  testDirectory: tests
  testFilePatterns:
    - tests/**/*.test.ts
testConventions:
  - BDD Given When Then
  - framework-neutral interactions
dataRules:
  syntheticDataOnly: true
  secretsAllowed: false
  allowedDataSources:
    - fixtures
    - mocks
    - local-artifacts
hardRules:
  - Do not invent selectors, endpoints, credentials, or expected behavior.
  - Keep automation patches test-only and repository-relative.
providerAccess:
  jira: read-only-allowlist
  github: read-only-allowlist
```

The profile describes policy and conventions; it does not authenticate to Jira
or GitHub and does not authorize writes.
