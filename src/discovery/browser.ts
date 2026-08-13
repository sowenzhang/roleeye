import { SourceError } from '../util/errors.js';
import type { Logger } from '../util/logger.js';
import { assertUrlAllowed } from './url-guard.js';

/**
 * Optional Playwright rendering for career pages that build their listings in
 * the browser.
 *
 * Playwright is deliberately not a dependency: it is a large install that most
 * users never need, and architecture.md ranks browser automation last among
 * discovery methods. It is loaded dynamically and only when a source opts in.
 */

interface MinimalBrowser {
  newPage(): Promise<MinimalPage>;
  close(): Promise<void>;
}

interface MinimalPage {
  goto(url: string, options?: { waitUntil?: string; timeout?: number }): Promise<unknown>;
  content(): Promise<string>;
}

interface PlaywrightModule {
  chromium: { launch(options?: { headless?: boolean }): Promise<MinimalBrowser> };
}

async function importPlaywright(): Promise<PlaywrightModule> {
  // Not a static import: playwright is an optional peer, absent by default.
  const moduleName = 'playwright';
  return (await import(moduleName)) as unknown as PlaywrightModule;
}

export interface BrowserRenderOptions {
  timeoutMs?: number;
  /** Injectable for tests. */
  load?: () => Promise<PlaywrightModule>;
}

/** Renders a page and returns its HTML. The URL guard applies here too. */
export async function renderWithBrowser(
  url: string,
  logger: Logger,
  options: BrowserRenderOptions = {},
): Promise<string> {
  await assertUrlAllowed(url);

  let playwright: PlaywrightModule;
  try {
    playwright = await (options.load ?? importPlaywright)();
  } catch {
    throw new SourceError(
      'browser',
      'browser_fallback is enabled but playwright could not be loaded. Run `npm install playwright` and `npx playwright install chromium`, or set browser_fallback: false.',
    );
  }

  const browser = await playwright.chromium.launch({ headless: true });

  try {
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'networkidle', timeout: options.timeoutMs ?? 30_000 });
    const html = await page.content();
    logger.debug('rendered page with browser', { bytes: html.length });
    return html;
  } finally {
    await browser.close();
  }
}
