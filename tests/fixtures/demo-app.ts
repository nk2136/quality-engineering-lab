import type { AddressInfo } from 'node:net';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type Locator, type Page } from '@playwright/test';
import { createDemoServer } from '../../src/demo-app.js';
import type { UiBrowserSession } from '../../src/ui-discovery.js';
import type { UiStructureSnapshot } from '../../src/ui-discovery.js';

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

  async inspectStructure(): Promise<UiStructureSnapshot> {
    return this.page.evaluate<UiStructureSnapshot>(() => {
      const elements = Array.from(document.querySelectorAll('table, tr, th, td, ul, ol, li, iframe'));
      const ids = new Map<Element, string>();
      const blockers: string[] = [];
      const kind = (element: Element): UiStructureSnapshot['evidence'][number]['kind'] => {
        const tag = element.tagName.toLowerCase();
        if (tag === 'table') return 'table';
        if (tag === 'tr') return 'row';
        if (tag === 'th' || tag === 'td') return 'cell';
        if (tag === 'ul' || tag === 'ol') return 'list';
        if (tag === 'li') return 'list-item';
        return 'frame';
      };
      const id = (element: Element) => {
        const known = ids.get(element);
        if (known) return known;
        const value = `structure-${ids.size + 1}`;
        ids.set(element, value);
        return value;
      };
      const quote = (value: string) => value.replaceAll('"', '\\"');
      const locator = (element: Element, scope?: string) => {
        const tag = element.tagName.toLowerCase();
        const label = element.getAttribute('aria-label') ?? element.getAttribute('title');
        if (label) return `${tag}[${element.hasAttribute('aria-label') ? 'aria-label' : 'title'}="${quote(label)}"]`;
        const text = (element.textContent ?? '').replace(/\s+/g, ' ').trim();
        return text ? `${scope ? `${scope} >> ` : ''}${tag}:has-text("${quote(text)}")` : `${scope ? `${scope} >> ` : ''}${tag}`;
      };
      const evidence = elements.map((element) => {
        const label = element.getAttribute('aria-label') ?? element.getAttribute('title');
        const parent = elements.find((candidate) => candidate.contains(element) && candidate !== element);
        return {
          id: id(element),
          kind: kind(element),
          parentId: parent ? id(parent) : null,
          locator: locator(element),
          role: element.getAttribute('role'),
          name: label,
          childCount: element.children.length,
        };
      });
      for (const host of Array.from(document.querySelectorAll('*')).filter((element) => element.shadowRoot)) {
        const hostLocator = locator(host);
        const hostId = id(host);
        evidence.push({
          id: hostId, kind: 'shadow-root', parentId: null, locator: hostLocator,
          role: null, name: null, childCount: host.shadowRoot?.children.length ?? 0,
        });
        for (const child of Array.from(host.shadowRoot?.children ?? [])) {
          evidence.push({
            id: id(child), kind: 'element', parentId: hostId, locator: locator(child, hostLocator),
            role: child.getAttribute('role'), name: child.getAttribute('aria-label'), childCount: child.children.length,
          });
        }
      }
      for (const frame of Array.from(document.querySelectorAll('iframe'))) {
        const frameId = id(frame);
        const frameLocator = locator(frame);
        for (const child of Array.from(frame.contentDocument?.body.children ?? [])) {
          evidence.push({
            id: id(child), kind: 'element', parentId: frameId, locator: locator(child, `${frameLocator} >> frame`),
            role: child.getAttribute('role'), name: child.getAttribute('aria-label'), childCount: child.children.length,
          });
        }
      }
      const seen = new Set<string>();
      for (const item of evidence) {
        if (seen.has(item.locator)) blockers.push(`Ambiguous structural locator '${item.locator}'.`);
        seen.add(item.locator);
      }
      return {
        evidence,
        blockers: [...blockers, ...Array.from(document.querySelectorAll('[data-shadow-root="closed"]'))
          .map((element) => `Closed shadow root at ${element.tagName.toLowerCase()} cannot be inspected.`)],
      };
    });
  }

  async close(): Promise<void> {
    await this.#browser?.close();
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
