import { afterEach, describe, expect, it } from 'vitest';
import { UiDiscoveryAgent, type UiBrowserSession } from '../src/ui-discovery.js';
import { createPlaywrightSession, startDemoApp, type DemoApp } from './fixtures/demo-app.js';

const traceId = '3d594650-3436-4d7c-86a7-2b94788009bc';

class FakeBrowser implements UiBrowserSession {
  opened = false;
  fills: string[] = [];
  submits = 0;
  readonly counts = new Map<string, number>();

  async open(): Promise<void> {
    this.opened = true;
  }

  async fill(locator: string, value: string): Promise<void> { this.fills.push(`${locator}:${value}`); }
  async submit(): Promise<void> { this.submits += 1; }
  async accessibilitySnapshot(): Promise<string> { return `<main data-submit-count="${this.submits}" />`; }
  async locatorCount(locator: string): Promise<number> { return this.counts.get(locator) ?? 0; }
  async screenshot(): Promise<string> { return 'screenshot.png'; }
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
