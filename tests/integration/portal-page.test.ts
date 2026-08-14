import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { runInNewContext } from 'node:vm';
import { renderIndex } from '../../src/portal/index-page.js';
import { createRoutes } from '../../src/portal/routes.js';
import { ConfigService } from '../../src/portal/config-service.js';
import { startPortal } from '../../src/portal/server.js';
import { resolvePaths } from '../../src/config/paths.js';
import { openDatabase } from '../../src/db/database.js';
import { createRepositories } from '../../src/db/repositories/index.js';
import { silentLogger } from '../../src/util/logger.js';

/**
 * Executes the page's embedded script against a minimal DOM.
 *
 * The script is a string inside a TypeScript file, so the compiler never sees
 * it and a typo survives every other check. This ran the real page against the
 * real routes and caught a reference error on the first attempt.
 */

interface Node {
  tagName: string;
  children: Node[];
  attrs: Record<string, string>;
  textContent: string;
  [key: string]: unknown;
}

function element(tag: string): Node {
  return {
    tagName: tag,
    children: [],
    attrs: {},
    style: {},
    className: '',
    textContent: '',
    value: '',
    checked: false,
    type: '',
    onclick: null,
    setAttribute(this: Node, key: string, value: string) {
      this.attrs[key] = value;
    },
    append(this: Node, ...kids: Node[]) {
      this.children.push(...kids);
    },
    replaceChildren(this: Node, ...kids: Node[]) {
      this.children = kids;
    },
    addEventListener() {},
  };
}

const workspaces: string[] = [];

after(() => {
  for (const dir of workspaces) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows may still hold a handle on the database file.
    }
  }
});

async function renderPage(): Promise<{
  node: (id: string) => Node;
  missing: Set<string>;
  errors: unknown[];
}> {
  const root = mkdtempSync(path.join(tmpdir(), 'roleeye-page-'));
  mkdirSync(path.join(root, 'config'), { recursive: true });
  workspaces.push(root);

  const paths = resolvePaths(root);
  const html = renderIndex();

  const registry = new Map<string, Node>();
  const missing = new Set<string>();
  for (const match of html.matchAll(/id="([^"]+)"/g)) registry.set(match[1]!, element('div'));

  const portal = await startPortal({
    port: 0,
    logger: silentLogger,
    index: renderIndex,
    routes: createRoutes({
      config: new ConfigService(paths),
      logger: silentLogger,
      loadConfig: () => {
        throw new Error('the page must not need a loaded config to render');
      },
      openDb: () => ({ repos: createRepositories(openDatabase({ path: ':memory:' })) }),
    }),
  });

  const errors: unknown[] = [];
  const onRejection = (error: unknown) => errors.push(error);
  process.on('unhandledRejection', onRejection);

  try {
    runInNewContext(html.split('<script>')[1]!.split('</script>')[0]!, {
      document: {
        createElement: element,
        createElementNS: (_ns: string, tag: string) => element(tag),
        getElementById(id: string) {
          if (!registry.has(id)) {
            missing.add(id);
            registry.set(id, element('div'));
          }
          return registry.get(id);
        },
      },
      location: { search: `?token=${portal.token}` },
      URLSearchParams,
      console,
      setTimeout,
      JSON,
      Promise,
      fetch: (route: string, init?: RequestInit) =>
        fetch(`http://127.0.0.1:${portal.port}${route}`, {
          ...init,
          headers: { 'content-type': 'application/json', 'x-roleeye-token': portal.token, ...(init?.headers ?? {}) },
        }),
    });

    await new Promise((resolve) => setTimeout(resolve, 1_500));
  } finally {
    process.off('unhandledRejection', onRejection);
    await portal.close();
  }

  return { node: (id) => registry.get(id) ?? element('div'), missing, errors };
}

describe('portal page', () => {
  it('runs without referencing anything that does not exist', async () => {
    const { missing, errors } = await renderPage();

    assert.deepEqual([...missing], [], 'every element the script touches must exist in the markup');
    assert.deepEqual(errors, [], 'the page must load without a runtime error');
  });

  it('always offers a way to run without sending anything anywhere', async () => {
    const { node } = await renderPage();
    const engines = node('engines').children;

    assert.ok(engines.length >= 3, 'the model choices are rendered');

    const labels = engines.map((engine) => String((engine.children[0]?.children[0] as Node | undefined)?.textContent));
    assert.ok(labels.includes('No model'), 'declining a model is a first-class choice');

    const costs = engines.map((engine) => String((engine.children[2] as Node | undefined)?.textContent));
    assert.ok(
      costs.some((cost) => cost.startsWith('free, runs here')),
      'a local option is offered and named as free',
    );
    assert.ok(
      costs.some((cost) => cost.includes('per 100 roles')),
      'a hosted option states its price before it is chosen',
    );

    const selected = engines.filter((engine) => engine.attrs['aria-pressed'] === 'true');
    assert.equal(selected.length, 1, 'exactly one model is selected at all times');
  });

  it('renders the pickers rather than asking for typed input', async () => {
    const { node } = await renderPage();

    assert.equal(node('passes').children.length, 2, 'depth is chosen, not typed');
    assert.ok(node('budget').children.length >= 3, 'the spending ceiling is chosen, not typed');
    assert.ok(node('catalog').children.length > 20, 'companies come preloaded');
  });
});
