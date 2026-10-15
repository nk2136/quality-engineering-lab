# SDET editor agents implementation plan

**Goal:** Provide named VS Code agents with a durable local human-decision interface.

**Architecture:** Keep routing policy in the coordinator, persist request/response artifacts through existing stores, expose narrow stdio MCP operations, and provide repo-local agent definitions.

**Tech stack:** Node 22, TypeScript, Zod, Vitest, MCP SDK, VS Code Copilot.

- [x] Add failing tests for owned questions, immutable response persistence, version binding, stale/concurrent response rejection, same-stage resume, and paused transition refusal.
- [x] Add decision schemas/service and human-decision artifact kinds. Preserve approval state. Add filesystem workflow enumeration and reject running/transitioning while waiting-for-human.
- [x] Add an MCP SDK dependency and tests through a real MCP client. Register narrow workflow, evidence and decision operations with schemas and write annotations.
- [x] Add a stdio entry point, idempotent mock seed command, VS Code server configuration, and seven custom agent definitions.
- [x] Use Taskmaster tasks for implementation tracking. Verify the deterministic suite, stdio transport, restart persistence, agent metadata, and diff whitespace. Document VS Code setup and real remaining workflow limitations.
