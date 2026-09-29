import { access, rm } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { UiDiscoveryAgent, type UiBrowserSession, type UiStructureSnapshot } from '../src/ui-discovery.js';
import { createPlaywrightSession, startDemoApp, type DemoApp } from './fixtures/demo-app.js';

const traceId = '3d594650-3436-4d7c-86a7-2b94788009bc';

class FakeBrowser implements UiBrowserSession {
  opened = false;
  fills: string[] = [];
  submits = 0;
  readonly counts = new Map<string, number>();
  structure: UiStructureSnapshot = {
    evidence: [
      { id: 'table', kind: 'table', parentId: null, locator: 'getByRole(table)', role: 'table', name: 'Benefits', childCount: 1 },
      { id: 'row', kind: 'row', parentId: 'table', locator: 'getByRole(row).nth(1)', role: 'row', name: null, childCount: 2 },
      { id: 'list', kind: 'list', parentId: null, locator: 'getByRole(list)', role: 'list', name: 'Checks', childCount: 1 },
      { id: 'shadow', kind: 'shadow-root', parentId: null, locator: 'custom-card', role: null, name: null, childCount: 1 },
      { id: 'frame', kind: 'frame', parentId: null, locator: 'iframe[title="Details"]', role: null, name: 'Details', childCount: 1 },
    ],
    blockers: ['Closed shadow root at secure-card cannot be inspected.'],
  };

  async open(): Promise<void> {
    this.opened = true;
  }

  async fill(locator: string, value: string): Promise<void> { this.fills.push(`${locator}:${value}`); }
  async submit(): Promise<void> { this.submits += 1; }
  async accessibilitySnapshot(): Promise<string> { return `<main data-submit-count="${this.submits}" />`; }
  async locatorCount(locator: string): Promise<number> { return this.counts.get(locator) ?? 0; }
  async screenshot(): Promise<string> { return 'screenshot.png'; }
  async inspectStructure() { return this.structure; }
  async close(): Promise<void> {}
}

function request(overrides: Record<string, unknown> = {}) {
  return {
    traceId,
    requirementArtifactId: 'requirement:QE-42',
    baseUrl: 'http://127.0.0.1:4321',
    routes: ['/eligibility'],
    startPath: '/eligibility',
    allowedActions: ['navigate', 'fill', 'submit'],
    ...overrides,
  };
}

describe('UiDiscoveryAgent policy', () => {
  it('rejects a start path outside the route allowlist', async () => {
    const agent = new UiDiscoveryAgent(() => new FakeBrowser());

    await expect(agent.discover(request({ startPath: '/admin' }))).rejects.toThrow(
      'not in the authorized route allowlist',
    );
  });

  it('rejects a protocol-relative start path before opening a browser session', async () => {
    const browser = new FakeBrowser();
    const agent = new UiDiscoveryAgent(() => browser);

    await expect(agent.discover(request({
      routes: ['//example.invalid/eligibility'], startPath: '//example.invalid/eligibility',
    }))).rejects.toThrow('loopback');
    expect(browser.opened).toBe(false);
  });

  it('rejects a destructive action before opening a browser session', async () => {
    const browser = new FakeBrowser();
    const agent = new UiDiscoveryAgent(() => browser);

    await expect(agent.discover(request({ allowedActions: ['delete-history'] }))).rejects.toThrow(
      'not permitted for UI discovery',
    );
    expect(browser.opened).toBe(false);
  });
});

describe('UiDiscoveryAgent evidence', () => {
  it('returns scoped table, list, frame, and shadow-root evidence with blockers', async () => {
    const agent = new UiDiscoveryAgent(() => new FakeBrowser());

    const result = await agent.discover(request());

    expect(result.structures).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'row', parentId: 'table', kind: 'row' }),
      expect.objectContaining({ id: 'shadow', kind: 'shadow-root' }),
      expect.objectContaining({ id: 'frame', kind: 'frame' }),
    ]));
    expect(result.structuralBlockers).toContain('Closed shadow root at secure-card cannot be inspected.');
  });

  it('prefers a unique role-and-name locator', async () => {
    const browser = new FakeBrowser();
    browser.counts.set('getByRole(button, { name: "Check eligibility" })', 1);
    const agent = new UiDiscoveryAgent(() => browser);

    const result = await agent.discover(request());

    expect(result.locators[0]).toMatchObject({
      locator: 'getByRole(button, { name: "Check eligibility" })',
      strategy: 'role-name',
      count: 1,
    });
  });

  it('records a blocker when no locator is unique', async () => {
    const browser = new FakeBrowser();
    browser.counts.set('getByRole(button, { name: "Check eligibility" })', 2);
    const agent = new UiDiscoveryAgent(() => browser);

    const result = await agent.discover(request());

    expect(result.locators).toEqual([]);
    expect(result.blockers).toContain('No unique locator for Check eligibility.');
  });

  it('collects validation and success observations through allowed form actions', async () => {
    const browser = new FakeBrowser();
    const agent = new UiDiscoveryAgent(() => browser);

    const result = await agent.discover(request());

    expect(browser.fills).toEqual(['getByLabel("Member ID"):MEMBER-42']);
    expect(browser.submits).toBe(2);
    expect(result.observations.map(({ state }) => state)).toEqual([
      'initial', 'empty', 'validation', 'success',
    ]);
    expect(result.performedActions).toEqual(['navigate', 'submit', 'fill', 'submit']);
  });
});

describe('UiDiscoveryAgent local browser', () => {
  let app: DemoApp | undefined;

  afterEach(async () => {
    await app?.close();
  });

  it('discovers the local eligibility flow without destructive actions', async () => {
    app = await startDemoApp();
    const agent = new UiDiscoveryAgent(createPlaywrightSession);

    const result = await agent.discover(request({ baseUrl: app.url }));

    expect(result.locators).toContainEqual(expect.objectContaining({ strategy: 'role-name', count: 1 }));
    expect(result.observations.map(({ state }) => state)).toEqual([
      'initial', 'empty', 'validation', 'success',
    ]);
    expect(result.performedActions).not.toContain('delete-history');
  });

  it('maps local table, list, frame, and open shadow-root relationships', async () => {
    app = await startDemoApp();
    const agent = new UiDiscoveryAgent(createPlaywrightSession);

    const result = await agent.discover(request({ baseUrl: app.url }));

    expect(result.structures.map(({ kind }) => kind)).toEqual(expect.arrayContaining([
      'table', 'row', 'cell', 'list', 'list-item', 'frame', 'shadow-root',
    ]));
    expect(result.structures.find(({ kind }) => kind === 'row')?.parentId).not.toBeNull();
    expect(result.structuralBlockers).toContain('Closed shadow root at secure-card cannot be inspected.');
    expect(result.structures.filter(({ parentId }) => parentId !== null && result.structures.some(({ id }) => id === parentId))).not.toEqual([]);
    expect(new Set(result.structures.map(({ locator }) => locator)).size).toBe(result.structures.length);
    const frame = result.structures.find(({ kind }) => kind === 'frame');
    const shadow = result.structures.find(({ kind }) => kind === 'shadow-root');
    expect(result.structures).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'element', parentId: frame?.id }),
      expect.objectContaining({ kind: 'element', parentId: shadow?.id }),
    ]));
  });

  it('retains discovery screenshots after the browser session closes', async () => {
    app = await startDemoApp();
    const result = await new UiDiscoveryAgent(createPlaywrightSession).discover(request({ baseUrl: app.url }));
    const screenshots = result.observations.map(({ screenshotRef }) => screenshotRef);

    await Promise.all(screenshots.map((path) => access(path)));
    await Promise.all(screenshots.map((path) => rm(path, { force: true })));
  });

  it('blocks an external redirect before collecting evidence', async () => {
    app = await startDemoApp();
    const agent = new UiDiscoveryAgent(createPlaywrightSession);

    await expect(agent.discover(request({
      baseUrl: app.url,
      routes: ['/redirect'],
      startPath: '/redirect',
      allowedActions: ['navigate'],
    }))).rejects.toThrow('loopback');
  });
});
