# Knowledge assembly

Story Readiness needs different query semantics for each product-knowledge source. Jira's read-only issue adapter accepts exactly one issue key, while repository, API, and test indexes generally need broader semantic queries. Sending one shared query to every adapter either weakens Jira's boundary or produces poor retrieval.

`assembleKnowledge` accepts one bounded query per source and executes them independently. `CompositeKnowledgeSource` routes each query to its configured adapter. The Story Readiness workflow supports a `sourceQueries` map and retains `queryText` as an explicit fallback for sources that do not need specialized text.

The assembler enforces these invariants:

- each planned query targets exactly one source;
- at most one query is accepted for each source in a run;
- evidence returned by an adapter must identify that same source;
- results are sorted by relevance, retrieval time, and stable evidence ID;
- identical source, URI, and revision tuples are included once;
- a global result limit is applied after cross-source ranking.

Adapters remain read-only and receive only their own query. The assembler does not perform authentication, generate JQL, call live services by itself, or write retrieved data back to Jira.

The integration test uses a mocked Jira HTTP response and an in-memory GitHub architecture source. It exercises retrieval, context construction, model response validation, deterministic scoring, artifact persistence, and the human-review stop without credentials or network access.
