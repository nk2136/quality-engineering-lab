import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type Locator, type Page } from '@playwright/test';
import { createDemoServer } from '../../src/demo-app.js';
import type { UiBrowserSession } from '../../src/ui-discovery.js';

export interface DemoApp {
  readonly url: string;
  close(): Promise<void>;
}

export async function startDemoApp(): Promise<DemoApp> {
  const server = createDemoServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

function isLoopback(url: URL): boolean {
  return url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname);
}

class PlaywrightSession implements UiBrowserSession {
  #browser: Browser | undefined;
  #page: Page | undefined;
  #screenshots: string | undefined;

  async open(url: string): Promise<void> {
    this.#browser = await chromium.launch();
    this.#page = await this.#browser.newPage();
    await this.#page.route('**/*', (route) => {
      const requestUrl = new URL(route.request().url());
      return isLoopback(requestUrl) ? route.continue() : route.abort();
    });
    try {
      await this.#page.goto(url, { waitUntil: 'domcontentloaded' });
    } catch (error) {
      throw new Error('UI discovery blocked a non-loopback browser request.', { cause: error });
    }
    if (!isLoopback(new URL(this.#page.url()))) throw new Error('UI discovery ended outside the loopback boundary.');
    this.#screenshots = await mkdtemp(join(tmpdir(), 'qa-agents-ui-'));
  }

  async fill(locator: string, value: string): Promise<void> { await this.locator(locator).fill(value); }
  async submit(locator: string): Promise<void> { await this.locator(locator).click(); }
  async accessibilitySnapshot(): Promise<string> { return this.page.locator('body').ariaSnapshot(); }
  async locatorCount(locator: string): Promise<number> { return this.locator(locator).count(); }

  async screenshot(name: string): Promise<string> {
    const path = join(this.#screenshots ?? tmpdir(), `${name}.png`);
    await this.page.screenshot({ path });
    return path;
  }

  async close(): Promise<void> {
    await this.#browser?.close();
    if (this.#screenshots) await rm(this.#screenshots, { recursive: true, force: true });
  }

  private get page(): Page {
    if (!this.#page) throw new Error('Browser session has not opened.');
    return this.#page;
  }

  private locator(value: string): Locator {
    if (value === 'getByRole(button, { name: "Check eligibility" })') {
      return this.page.getByRole('button', { name: 'Check eligibility' });
    }
    if (value === 'getByLabel("Member ID")') return this.page.getByLabel('Member ID');
    if (value === 'getByTestId("eligibility-submit")') return this.page.getByTestId('eligibility-submit');
    return this.page.locator(value);
  }
}

export function createPlaywrightSession(): UiBrowserSession {
  return new PlaywrightSession();
}
