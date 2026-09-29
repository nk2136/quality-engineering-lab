# Locator Intelligence Implementation Plan

> **For agentic workers:** Use test-first implementation and preserve explicit evidence boundaries.

**Goal:** Extend UI Discovery with scope-aware structural evidence for tables, lists, parent-child containers, frames, and open Shadow DOM.

**Architecture:** Keep browser-specific traversal in the Playwright fixture. The agent consumes a typed structure snapshot, returns it alongside locator evidence, and reports closed/opaque boundaries as blockers instead of guessing selectors.

### Task 1: Structural contract

**Files:** Modify `src/ui-discovery.ts`; modify `tests/ui-discovery.test.ts`.

- [ ] Write failing tests for a table row/cell, list item, iframe, open shadow root, and opaque boundary blocker.
- [ ] Add Zod-validated `UiStructureEvidence` with scope ID, kind, parent scope, role, accessible name, stable locator, and child count. Add `inspectStructure()` to `UiBrowserSession`.
- [ ] Verify focused tests pass and commit `feat: add locator structure evidence`.

### Task 2: Local fixture traversal

**Files:** Modify `src/demo-app.ts`; modify `tests/fixtures/demo-app.ts`; modify `tests/ui-discovery.test.ts`.

- [ ] Add deterministic table, list, open-shadow component, and frame fixtures.
- [ ] Implement Playwright inspection across documents, frames, and open shadow roots. Capture stable ancestor paths and reject positional XPath; record closed/opaque roots as blockers.
- [ ] Verify the local browser acceptance case and commit `feat: inspect scoped UI structures`.

### Task 3: Documentation and regression verification

**Files:** Modify `README.md`; modify `tests/ui-discovery.test.ts`.

- [ ] Document semantic-first ranking, frame/shadow scope, CSS/XPath fallback warning, and closed-root limitation.
- [ ] Run `npm run check`, `npm run test:ui`, and `git diff --check`.
- [ ] Commit `docs: document locator intelligence boundaries`.
