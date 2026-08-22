# AI Engineering Landscape and Architecture Decisions

Research date: 2026-08-22

## Purpose

This document turns the current AI-agent ecosystem into decisions for an agentic quality-engineering platform. The target is an auditable workflow spanning Jira refinement, architecture-aware planning, implementation, testing, defect handling, release approval, deployment, and production feedback.

Popularity is a discovery signal, not an adoption criterion. A dependency enters the platform only when it solves a distinct problem, is actively maintained, has an acceptable license and security posture, integrates cleanly with TypeScript, and beats a small in-house baseline in evaluation.

## Recommended architecture

| Layer | Initial choice | Decision |
|---|---|---|
| Agent runtime | OpenAI Agents SDK for TypeScript | Keep. It already supplies typed outputs, tools, handoffs, guardrails, approvals, tracing, and provider adapters. |
| Lifecycle coordinator | Explicit state machine now; evaluate Temporal before cross-sprint workflows | Agent reasoning must not be the system of record. Durable execution becomes valuable when runs wait days for people, CI, or releases. |
| Jira and Confluence | Official Atlassian Rovo MCP for exploration; Jira REST/webhooks behind our own adapter for production | MCP accelerates integration, but domain code must not depend on MCP tool names or incomplete write capabilities. Start read-only and approve writes. |
| Source control | GitHub adapter with least-privilege GitHub App permissions | Keep reads and proposed patches separate from merge authority. |
| Browser and UI testing | Playwright tests plus official `@playwright/mcp` for bounded exploration | Generated tests must be checked into the repository and replayable without an LLM. Run browsers in an isolated worker. |
| Product knowledge | Versioned context packs over source documents; begin with PostgreSQL + pgvector or Qdrant | Do not begin with a knowledge graph. Add Graphiti only if temporal relationships materially improve retrieval evals. |
| Working context | Retrieval budget, citations, deduplication, reranking, and compaction | Never paste an entire Jira project, Confluence space, or repository into a prompt. |
| Long-term memory | No framework in MVP; evaluate Mem0 and Supermemory later | Product truth belongs in governed sources. Memory is for learned preferences, adjudicated outcomes, and recurring facts—not a replacement for documentation. |
| Model gateway | A local `ModelGateway` interface; OpenAI by default; evaluate OpenRouter and LiteLLM | Business logic must request capabilities, not vendor model IDs. |
| Evaluation | Existing Vitest golden cases, expanded with promptfoo-style matrix tests and trajectory assertions | Every prompt, model, retrieval, or routing change must run offline regressions before release. |
| Observability | OpenAI traces initially; OpenTelemetry export, then compare Langfuse and Phoenix | Record model, prompt version, retrieved evidence, tool calls, tokens, cost, latency, approvals, and final verdict. |
| Sandboxing | Ephemeral Docker workers first; evaluate E2B/Daytona if isolation operations become burdensome | Generated code never runs on the coordinator host or with production credentials. |

## Context architecture

The platform needs five separate forms of state:

1. **Workflow state** — story ID, current stage, approvals, retries, artifacts, and timestamps. Store deterministically.
2. **Product knowledge** — requirements, architecture decisions, APIs, code ownership, test history, and runbooks. Retrieve from versioned sources with citations.
3. **Working context** — the small evidence pack required for the current agent step. Apply a token budget and relevance thresholds.
4. **Episodic memory** — prior agent actions and human decisions that may improve a later run. Retain selectively with provenance and expiry.
5. **Model conversation state** — recent messages and tool results. Compact when long-running, but never treat a compaction summary as authoritative product data.

### Context-pack contract

Every specialist receives a typed `ContextPack` containing:

- objective and workflow stage;
- immutable identifiers and source revisions;
- acceptance criteria and constraints;
- retrieved evidence with URI, version, timestamp, and relevance score;
- architecture and ownership facts;
- prior test or production signals;
- unresolved contradictions and missing evidence;
- explicit token budget and truncation report.

The retrieval pipeline is: query decomposition, permission filtering, hybrid retrieval, reranking, deduplication, freshness checks, budget packing, then citation validation. Agents must say `insufficient_evidence` rather than invent missing product knowledge.

### Token and latency controls

- Put stable instructions, tool definitions, schemas, and examples before variable input to maximize exact-prefix prompt caching.
- Keep secrets, clients, loggers, and authorization state in runtime context, never model-visible context.
- Use small models for extraction, classification, and formatting; use stronger reasoning or coding models only after a complexity gate.
- Retrieve summaries first and details on demand. Cache retrieval by source revision, not only by query text.
- Compact long model conversations, but preserve structured workflow state and cited artifacts outside the conversation.
- Track input, cached input, output, retrieval, and tool costs per story and per stage.

## Model routing and fallback policy

OpenRouter distinguishes provider failover from model fallback. We should preserve that distinction:

| Failure | Action |
|---|---|
| Provider timeout, rate limit, or outage | Retry another provider for the same model when data policy permits. |
| Context window exceeded | Repack/compact context; do not silently select a larger model first. |
| Structured-output or tool incompatibility | Route only to a model whose capability manifest satisfies the contract. |
| Safety or moderation refusal | Escalate or apply the declared policy; do not use fallback to bypass a safety decision. |
| Low-confidence task result | Retrieve more evidence or request human review; a second model may critique, not automatically overwrite. |
| Budget threshold exceeded | Pause or select an approved lower-cost tier, then label the decision and re-run the relevant eval. |

Each model deployment has a capability manifest: provider, model/version, structured-output support, tool support, context limit, data region, retention policy, cost ceiling, latency SLO, and approved task classes. A fallback is allowed only when it satisfies the same contract. The selected model and reason are part of the audit record.

Kimi K3, Kimi K2.5, Qwen coding models, DeepSeek, and other open-weight models are candidates—not assumptions. They enter a routing tier only after running our Jira analysis, test design, code generation, failure triage, and security suites. Self-hosting very large mixture-of-experts models is an infrastructure decision, not a free-cost shortcut.

## Repository and tool assessment

| Project | Useful capability | Position for this project |
|---|---|---|
| `openai/openai-agents-js` | Lightweight TypeScript agent runtime, typed outputs, tools, tracing, guardrails, providers | **Adopted foundation.** Avoid adding a second general agent framework. |
| `langchain-ai/langgraphjs` | Stateful graph orchestration and human-in-the-loop | **Reference/conditional.** Reconsider only if our explicit state machine becomes hard to evolve; do not run it beside Temporal without a clear boundary. |
| `temporalio/sdk-typescript` | Durable, replayable long-running workflows | **Pilot before production lifecycle.** Best fit for waiting on humans, CI, deployments, and recovery. |
| `BerriAI/litellm` | Self-hosted multi-provider gateway and OpenAI-compatible interface | **Evaluate.** Strong when centralized keys, quotas, and provider routing are required; adds Python/control-plane operations. |
| OpenRouter | Hosted catalog, provider routing, provider failover, opt-in model fallback | **Evaluate for experimentation.** Keep an adapter so it can be replaced and apply data-governance restrictions. |
| `mem0ai/mem0` | Extract-and-retrieve long-term agent memory | **Benchmark later.** Useful for learned facts; not the product-knowledge source of truth. |
| `supermemoryai/supermemory` | TypeScript memory/context engine with aggressive context reduction claims | **Promising benchmark candidate.** Verify claims on our corpus and assess self-hosted maturity. |
| `getzep/graphiti` | Temporal knowledge graphs with provenance and evolving facts | **Conditional.** Valuable for changing architecture/product relationships; Python/graph operational cost is too high for MVP without measured benefit. |
| PostgreSQL `pgvector` / Qdrant | Governed vector and hybrid retrieval | **Start simple.** Pick based on existing infrastructure; use a storage-neutral retrieval interface. |
| `langfuse/langfuse` | Self-hosted traces, prompt management, datasets, and evaluations | **Shortlist.** Strong integrated LLM operations option. |
| `arize-ai/phoenix` | Open-source tracing, evaluation, and troubleshooting | **Shortlist.** Compare through an OpenTelemetry proof of concept rather than instrumenting twice. |
| promptfoo | CI-oriented prompt/model matrices and red teaming | **Pattern to adopt.** If its current distribution/licensing fits, integrate; otherwise retain its matrix-test approach in Vitest. |
| `atlassian/atlassian-mcp-server` | Official OAuth access to Jira, Confluence, JSM, Bitbucket, and Compass | **Use for discovery/read paths.** Validate exact tool coverage; production writes use approval and a controlled adapter. |
| `microsoft/playwright-mcp` | Accessibility-snapshot browser control | **Use in sandboxed exploratory workflows.** Standard Playwright remains the reproducible test executor. |
| `modelcontextprotocol/servers` | MCP reference examples | **Learning only.** The repository explicitly describes them as reference implementations, not production servers. |
| Kimi K3 / K2.5 | Open-weight long-context, coding, reasoning, and multimodal candidates | **Evaluation tier.** Do not call this “Kimi 3” ambiguously; pin the exact model and provider. |

## Knowledge and skills required

### Core AI engineering

- Context engineering: source selection, token budgets, caching, compaction, retrieval, reranking, provenance, and freshness.
- Prompt contracts: focused instructions, examples, schemas, refusal states, confidence semantics, and version control.
- Tool engineering: narrow tools, idempotency, timeouts, retries, authorization, structured errors, and audit logs.
- Agent orchestration: specialist boundaries, deterministic routing, handoffs, parallelism, cancellation, and human checkpoints.
- Multi-model operations: capability manifests, routing, provider failover, model fallback, cost/latency SLOs, and data residency.
- Evaluation: golden datasets, deterministic assertions, LLM-judge calibration, pairwise comparison, trajectory/tool-call checks, retrieval metrics, red teaming, and production sampling.
- Observability: distributed traces, prompt/model versions, evidence lineage, token/cost accounting, feedback, and replay.
- Memory and RAG: embeddings, hybrid search, chunking, metadata filters, temporal facts, deletion, retention, and access control.

### Software delivery and quality engineering

- Jira workflow and requirement-quality analysis;
- architecture decision records, code ownership, dependency graphs, and API contracts;
- risk-based testing, test pyramids, contract/integration/UI testing, mutation and property-based testing;
- CI/CD, feature flags, canaries, rollback, release evidence, and change management;
- defect taxonomy, duplicate detection, severity calibration, root-cause evidence, and escaped-defect learning;
- SRE signals, OpenTelemetry, logs/metrics/traces, SLOs, incident response, and runbooks;
- supply-chain security, secret scanning, dependency review, SAST, sandbox escape prevention, and prompt-injection defense.

## Human-control boundaries

Human approval remains mandatory for acceptance-criteria changes, architecture decisions, permission expansion, generated-code merge, defect closure or severity override, production deployment, rollback, and changes to safety/data policies. Read-only analysis can be automated; externally visible writes need idempotency, previews, and an approval record.

## Delivery sequence

### Phase 0 — engineering substrate

- Define `ModelGateway`, `KnowledgeSource`, `ArtifactStore`, and `WorkflowStore` interfaces.
- Add trace IDs, prompt/model versions, evidence citations, cost accounting, and approval records.
- Build a representative evaluation corpus before optimizing models or memory.

### Phase 1 — Jira Story Readiness Agent

- Read Jira story, linked Confluence content, repository architecture, ownership, API specifications, and relevant test history.
- Produce structured gaps, contradictions, risks, questions, suggested acceptance criteria, and test strategy.
- Require human approval before Jira write-back.

### Phase 2 — implementation and verification

- Generate a change plan and bounded patch in an ephemeral sandbox.
- Run deterministic unit, contract, integration, security, and Playwright tests.
- Have a separate reviewer inspect evidence and policy compliance before proposing a pull request.

### Phase 3 — defect and CI intelligence

- Triage failures, cluster duplicates, identify likely owning component, gather reproduction evidence, and draft defects.
- Learn only from human-adjudicated outcomes.

### Phase 4 — release and production

- Assemble release evidence, perform policy gates, deploy via existing CI/CD, watch canary/SLO signals, and recommend rollback.
- Never give an LLM unrestricted production shell or deployment credentials.

## Adoption gates

Before adding any framework or model, require:

1. A concrete capability missing from the current stack.
2. Acceptable license, maintenance activity, vulnerability history, and dependency footprint.
3. Tenant isolation, deletion, retention, provenance, and least-privilege behavior.
4. A benchmark on our own stories and repositories measuring quality, recall, faithfulness, latency, cost, and failure modes.
5. A reversible adapter boundary and an operational owner.
6. No material regression in the golden evaluation suite.

## Primary sources

- OpenAI: [Agent definitions](https://developers.openai.com/api/docs/guides/agents/define-agents), [models and providers](https://developers.openai.com/api/docs/guides/agents/models), [prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching), and [compaction](https://developers.openai.com/api/docs/guides/compaction)
- GitHub: [OpenAI Agents SDK JS](https://github.com/openai/openai-agents-js), [LangGraph JS](https://github.com/langchain-ai/langgraphjs), and [Temporal TypeScript SDK](https://github.com/temporalio/sdk-typescript)
- Context and memory: [Mem0](https://github.com/mem0ai/mem0), [Graphiti](https://github.com/getzep/graphiti), and [Supermemory](https://github.com/supermemoryai/supermemory)
- Routing: [LiteLLM](https://github.com/BerriAI/litellm), [OpenRouter provider routing](https://openrouter.ai/docs/guides/routing/provider-selection), and [OpenRouter model fallbacks](https://openrouter.ai/docs/guides/routing/model-fallbacks)
- Integrations: [Atlassian Rovo MCP](https://github.com/atlassian/atlassian-mcp-server), [Playwright MCP](https://github.com/microsoft/playwright-mcp), and [MCP reference servers](https://github.com/modelcontextprotocol/servers)
- Observability: [Langfuse](https://github.com/langfuse/langfuse) and [Phoenix](https://github.com/Arize-ai/phoenix)
- Open models: [Kimi K3](https://www.kimi.ai/blog/kimi-k3), [Kimi K2.5](https://github.com/MoonshotAI/Kimi-K2.5), and [Kimi K2](https://github.com/moonshotai/kimi-k2)
