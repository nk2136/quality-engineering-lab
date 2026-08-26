# Foundation contracts

The Phase 0 ports keep agent workflows independent from specific model vendors, knowledge systems, databases, and workflow engines.

## Boundaries

- `ModelGateway` accepts a versioned prompt request and a validated `ContextPack`; adapters may target OpenAI, OpenRouter, LiteLLM, or another approved provider.
- `KnowledgeSource` returns cited `ContextEvidence`; Jira, Confluence, GitHub, OpenAPI, tests, CI, and telemetry remain replaceable adapters.
- `ArtifactStore` persists immutable, versioned outputs associated with a trace.
- `WorkflowStore` persists deterministic lifecycle state and uses optimistic concurrency to prevent two workers from silently overwriting each other.

## Reference storage behavior

The in-memory stores exist for unit tests and local workflows. They validate all writes, reject duplicate identifiers, return defensive copies, and order artifact queries deterministically. They are not durable production storage.

A production adapter must preserve these behaviors and add tenant isolation, authorization, encryption, retention/deletion rules, and operational telemetry. Workflow implementations should depend only on the interfaces in `src/contracts.ts`.
