import { afterEach, describe, expect, it } from 'vitest';
import { startDemoApp, type DemoApp } from './fixtures/demo-app.js';

describe('demo app', () => {
  let app: DemoApp | undefined;

  afterEach(async () => {
    await app?.close();
  });

  it('serves an accessible eligibility form on loopback', async () => {
    app = await startDemoApp();
    const response = await fetch(`${app.url}/eligibility`);

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toContain('aria-label="Eligibility check"');
  });
});
