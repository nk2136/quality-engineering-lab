# UI Discovery Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a loopback-only demo application and UI Discovery Agent that produces schema-validated UI-state and unique-locator evidence.

**Architecture:** A Node HTTP demo has deterministic accessibility states. The agent accepts an injected browser session, validates loopback URL, route, and action policy before navigation, and returns only stored local evidence references. Playwright is limited to the local acceptance adapter; model calls, credentials, repository inventory, coverage analysis, patch generation, approval, and execution are excluded.

**Tech Stack:** TypeScript 5.9, Node.js 22, Zod 4, Vitest 3, Playwright Chromium

---

## File structure

- `package.json`: Playwright dependency and `demo` / `test:ui` scripts.
- `src/demo-app.ts`: fixed loopback eligibility page.
- `src/ui-discovery.ts`: schemas, policy, browser boundary, locator ranking, evidence.
- `tests/fixtures/demo-app.ts`: ephemeral server and Playwright adapter.
- `tests/demo-app.test.ts`, `tests/ui-discovery.test.ts`: deterministic contract and browser tests.
- `.github/workflows/ci.yml`: installs Chromium before the default suite runs.
- `README.md`: local commands and safety boundary.

### Task 1: Create the local demo

**Files:** Modify `package.json`; create `src/demo-app.ts`, `tests/fixtures/demo-app.ts`, `tests/demo-app.test.ts`.

- [ ] **Step 1: Write the failing server test**

```ts
it('serves an accessible eligibility form on loopback', async () => {
  app = await startDemoApp();
  const response = await fetch(`${app.url}/eligibility`);
  expect(response.status).toBe(200);
  await expect(response.text()).resolves.toContain('aria-label="Eligibility check"');
});
```

- [ ] **Step 2: Verify red** — run `npx vitest run tests/demo-app.test.ts`; expect failure because `startDemoApp` is absent.

- [ ] **Step 3: Implement the minimum server**

Bind `node:http` only to `127.0.0.1` at port `0`; the fixture returns `{ url, close }`. `/eligibility` returns static HTML with a form labelled “Eligibility check”, required `member-id` input, “Check eligibility” button, hidden `role=status` “Eligible”, hidden `role=alert` “Member ID is required”, “No prior checks” section, and `data-action=delete-history` control. Do not persist data or make outbound calls. Add `@playwright/test` to dev dependencies plus:

```json
"demo": "tsx src/demo-app.ts",
"test:ui": "vitest run tests/ui-discovery.test.ts"
```

- [ ] **Step 4: Verify green** — run `npx vitest run tests/demo-app.test.ts`; expect one pass.
- [ ] **Step 5: Commit** — `git add package.json package-lock.json src/demo-app.ts tests/fixtures/demo-app.ts tests/demo-app.test.ts; git commit -m "feat: add local UI discovery demo"`.

### Task 2: Define policy-first discovery contracts

**Files:** Create `src/ui-discovery.ts`; create `tests/ui-discovery.test.ts`.

- [ ] **Step 1: Write failing policy tests**

```ts
it('rejects an unlisted start route', async () => {
  await expect(agent.discover({ ...request, startPath: '/admin' })).rejects.toThrow(
    'not in the authorized route allowlist',
  );
});
it('rejects destructive actions before a browser opens', async () => {
  await expect(agent.discover({ ...request, allowedActions: ['delete-history'] })).rejects.toThrow(
    'not permitted for UI discovery',
  );
  expect(browser.opened).toBe(false);
});
```

- [ ] **Step 2: Verify red** — run `npx vitest run tests/ui-discovery.test.ts -t "route|destructive"`; expect missing export failure.

- [ ] **Step 3: Implement validation and boundary**

Export Zod schemas and inferred `UiDiscoveryRequest`, `UiLocatorEvidence`, `UiObservation`, and `UiDiscoveryResult` types. Require UUID trace ID, nonempty requirement artifact ID, `http://localhost` or `http://127.0.0.1`, unique slash-prefixed routes, and an allowlisted start path. Export:

```ts
export interface UiBrowserSession {
  open(url: string): Promise<void>;
  fill(locator: string, value: string): Promise<void>;
  submit(locator: string): Promise<void>;
  accessibilitySnapshot(): Promise<string>;
  locatorCount(locator: string): Promise<number>;
  screenshot(name: string): Promise<string>;
  close(): Promise<void>;
}
```

Allow only `navigate`, `fill`, and `submit`; reject destructive and unknown actions before `open`. Invoke `fill` and `submit` only after the matching action passes policy validation. Close an opened session in `finally`.

- [ ] **Step 4: Verify green** — run `npx vitest run tests/ui-discovery.test.ts -t "route|destructive"`; expect pass without Chromium.
- [ ] **Step 5: Commit** — `git add src/ui-discovery.ts tests/ui-discovery.test.ts; git commit -m "feat: define UI discovery policy contracts"`.

### Task 3: Add locator and UI-state evidence

**Required interaction sequence:** After recording the initial form and empty state, call `submit('getByRole(button, { name: "Check eligibility" })')` to observe required-field validation. Then call `fill('getByLabel("Member ID")', 'MEMBER-42')` and submit the same button to observe success. The existing action allowlist must gate both methods.

**Files:** Modify `src/ui-discovery.ts`, `tests/ui-discovery.test.ts`.

- [ ] **Step 1: Write failing ranking tests**

```ts
it('prefers a unique role-and-name locator', async () => {
  browser.counts.set('getByRole(button, { name: "Check eligibility" })', 1);
  const result = await agent.discover(request);
  expect(result.locators[0]).toMatchObject({ strategy: 'role-name', count: 1 });
});
it('records a blocker when no locator is unique', async () => {
  browser.counts.set('getByRole(button, { name: "Check eligibility" })', 2);
  const result = await agent.discover(request);
  expect(result.locators).toEqual([]);
  expect(result.blockers).toContain('No unique locator for Check eligibility.');
});
```

- [ ] **Step 2: Verify red** — run `npx vitest run tests/ui-discovery.test.ts -t "unique|blocker"`; expect locator evidence assertion failure.

- [ ] **Step 3: Implement ranked evidence**

Rank candidate strategies exactly: role plus accessible name, associated label, stable `data-testid`, stable semantic text/attribute, CSS fallback. Emit only `locatorCount() === 1`; never emit XPath or positional selectors. If none are unique, add a blocker. Collect initial form, empty, validation, and success observations plus deterministic accessibility snapshot and screenshot references; sort results deterministically.

- [ ] **Step 4: Verify green** — run `npx vitest run tests/ui-discovery.test.ts -t "unique|blocker"`; expect pass.
- [ ] **Step 5: Commit** — `git add src/ui-discovery.ts tests/ui-discovery.test.ts; git commit -m "feat: collect bounded UI locator evidence"`.

### Task 4: Verify with local Chromium and document it

**Required loopback enforcement:** Before navigation, configure `page.route('**/*', handler)` to allow only `http:` requests to `localhost`, `127.0.0.1`, or `[::1]`, aborting every other request. After `page.goto`, reject discovery unless `page.url()` is also an allowed loopback URL. Add an acceptance test whose local route redirects to `https://example.invalid`, asserting discovery fails before any evidence is produced.

The adapter implements `fill(locator, value)` with `page.locator(locator).fill(value)` and `submit(locator)` with `page.locator(locator).click()`.

**Required CI change:** In the deterministic CI job, add `npx playwright install --with-deps chromium` after `npm ci` and before `npm run check`. The final Task 4 commit is:

```powershell
git add .github/workflows/ci.yml README.md package.json package-lock.json src/demo-app.ts src/ui-discovery.ts tests
git commit -m "feat: add bounded UI discovery agent"
```

**Files:** Modify `.github/workflows/ci.yml`, `tests/fixtures/demo-app.ts`, `tests/ui-discovery.test.ts`, `README.md`.

- [ ] **Step 1: Write the failing acceptance test**

```ts
it('discovers the local eligibility flow without destructive actions', async () => {
  const result = await discovery.discover({ ...request, baseUrl: app.url });
  expect(result.locators).toContainEqual(expect.objectContaining({ strategy: 'role-name', count: 1 }));
  expect(result.observations.map(({ state }) => state)).toEqual(
    expect.arrayContaining(['empty', 'validation', 'success']),
  );
  expect(result.performedActions).not.toContain('delete-history');
});
```

- [ ] **Step 2: Verify red** — run `npx vitest run tests/ui-discovery.test.ts -t "local eligibility flow"`; expect failure until adapter exists. If Chromium is absent, run `npx playwright install chromium`, then rerun; do not substitute an external site.

- [ ] **Step 3: Implement local adapter and docs**

Use `chromium.launch()`, one page, `page.goto(url, { waitUntil: 'domcontentloaded' })`, locator count, `page.locator('body').ariaSnapshot()`, and `page.screenshot({ path })`. Save screenshots in Vitest temporary paths. Document `npm run demo` and `npm run test:ui`, loopback-only navigation, no credentials, allowed form fill/submit, and denied destructive controls.

- [ ] **Step 4: Verify all changes** — run `npm run check; npm run test:ui; git diff --check`; expect TypeScript and all tests pass and the final command is silent.
- [ ] **Step 5: Commit** — `git add README.md package.json package-lock.json src/demo-app.ts src/ui-discovery.ts tests; git commit -m "feat: add bounded UI discovery agent"`.

## Self-review

- Covers loopback/route/action policy, observed states, ranked unique locators, accessibility/screenshot evidence, and ambiguity blockers.
- Keeps every requested out-of-scope external or approval capability excluded.
- Uses concrete TDD commands and a commit at each milestone.
