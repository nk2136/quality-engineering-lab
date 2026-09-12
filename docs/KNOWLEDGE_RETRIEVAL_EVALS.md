# Knowledge retrieval evaluations

Story Readiness quality depends on retrieving the correct product facts before model reasoning begins. Valid JSON and faithful citations are insufficient if the context pack omits the architecture decision, test history, or dependency that a human reviewer would use.

`evaluateKnowledgeRetrieval` compares an ordered `ContextEvidence` list with a human-authored golden case. It reports:

- **Recall at K** — expected evidence found in the first K results.
- **Precision at K** — relevant evidence among the returned first K results.
- **Reciprocal rank** — how early the first relevant result appears.
- **Source coverage** — required Jira, GitHub, CI, or other source types represented in the first K results.
- **Duplicate evidence** — repeated evidence IDs, which always fail the evaluation.

Each case supplies explicit thresholds. The initial sanitized corpus covers combined Jira and architecture retrieval plus test-history and CI retrieval. The mocked end-to-end Story Readiness test also evaluates the actual Jira and pinned GitHub adapters after context-budget packing, without network calls or credentials.

Retrieval metrics are intentionally deterministic and model-free so they can run on every pull request. New vector stores, rerankers, chunking strategies, or memory systems must improve this corpus without reducing citation faithfulness or Story Readiness decision agreement.
