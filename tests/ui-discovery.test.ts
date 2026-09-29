import { describe, expect, it } from 'vitest';
import { UiDiscoveryAgent, type UiBrowserSession } from '../src/ui-discovery.js';

const traceId = '3d594650-3436-4d7c-86a7-2b94788009bc';

class FakeBrowser implements UiBrowserSession {
  opened = false;

  async open(): Promise<void> {
    this.opened = true;
  }

  async fill(): Promise<void> {}
  async submit(): Promise<void> {}
  async accessibilitySnapshot(): Promise<string> { return '<main />'; }
  async locatorCount(): Promise<number> { return 0; }
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
