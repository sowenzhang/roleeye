import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { notifySchema } from '../../src/config/notify-schema.js';
import { buildToastXml, createDesktopNotifier, escapeXml } from '../../src/notify/desktop.js';
import { meetsThreshold } from '../../src/notify/digest.js';
import { createNotifiers, createTerminalNotifier } from '../../src/notify/index.js';
import { deliver, type Notification, type Notifier } from '../../src/notify/notifier.js';
import { checkWebhookUrl, createWebhookNotifier } from '../../src/notify/webhook.js';

function notification(over: Partial<Notification> = {}): Notification {
  return {
    kind: 'digest',
    summary: 'RoleEye: 1 role worth a look',
    detail: 'MAYBE 70 Northwind — Staff Engineer',
    items: [
      {
        jobId: 'job_1',
        company: 'Northwind',
        title: 'Staff Engineer',
        decision: 'MAYBE',
        score: 70,
        headline: 'real ownership, unclear level',
        url: 'https://example.com/jobs/1',
      },
    ],
    reviewHint: 'Run `roleeye recommend` to see the full reasoning.',
    occurredAt: '2026-08-13T12:00:00.000Z',
    ...over,
  };
}

describe('notification thresholds', () => {
  const config = notifySchema.parse({});

  it('defaults to interrupting only for APPLY', () => {
    assert.equal(meetsThreshold('APPLY', 80, config), true);
    assert.equal(meetsThreshold('MAYBE', 80, config), false, 'a notifier that fires on everything gets muted');
  });

  it('honours a lower bar when the user asks for one', () => {
    const relaxed = notifySchema.parse({ min_decision: 'MAYBE' });

    assert.equal(meetsThreshold('MAYBE', 70, relaxed), true);
    assert.equal(meetsThreshold('SKIP', 70, relaxed), false);
  });

  it('applies a score floor independently of the decision', () => {
    const strict = notifySchema.parse({ min_decision: 'ANY', min_score: 75 });

    assert.equal(meetsThreshold('APPLY', 74, strict), false);
    assert.equal(meetsThreshold('SKIP', 80, strict), true);
  });
});

describe('desktop toast', () => {
  it('escapes posting text so a job title cannot break the toast', () => {
    // Company names and titles are chosen by whoever posted the job.
    const hostile = notification({
      items: [
        {
          jobId: 'job_1',
          company: 'Ampersand & Co </text><text>injected',
          title: "It's a \"role\"",
          decision: 'APPLY',
          score: 90,
          headline: 'x',
          url: undefined,
        },
      ],
    });

    const xml = buildToastXml(hostile, 5);

    assert.ok(!xml.includes('</text><text>injected'), 'markup in a company name must not become markup');
    assert.ok(xml.includes('&amp;'));
    assert.ok(xml.includes('&apos;') || xml.includes('&quot;'));
    assert.equal(xml.split('<text').length - 1, 3, 'exactly the three text nodes we wrote');
  });

  it('strips control characters that would make the XML unloadable', () => {
    assert.equal(escapeXml('a\u0001b'), 'a b');
  });

  it('passes content through the environment, never the script text', async () => {
    const calls: Array<{ args: string[]; env: NodeJS.ProcessEnv }> = [];

    const notifier = createDesktopNotifier({
      maxItems: 5,
      platform: 'win32',
      exec: async (_command, args, options) => {
        calls.push({ args, env: options.env });
        return undefined;
      },
    });

    await notifier.send(notification());

    const script = Buffer.from(calls[0]!.args.at(-1)!, 'base64').toString('utf16le');
    assert.ok(!script.includes('Northwind'), 'posting text must not be inside the script');
    assert.match(String(calls[0]!.env['ROLEEYE_TOAST_XML']), /Northwind/);
  });

  it('says why it cannot deliver rather than pretending it did', async () => {
    const notifier = createDesktopNotifier({ maxItems: 5, platform: 'linux' });

    const result = await notifier.send(notification());

    assert.equal(result.delivered, false);
    assert.match(result.reason!, /Windows/);
  });
});

describe('webhook destination', () => {
  it('allows https anywhere and http only on loopback', () => {
    assert.equal(checkWebhookUrl('https://hooks.example.com/abc').ok, true);
    assert.equal(checkWebhookUrl('http://127.0.0.1:8080/hook').ok, true);
    assert.equal(checkWebhookUrl('http://example.com/hook').ok, false, 'a job search must not cross the network in clear text');
    assert.equal(checkWebhookUrl('file:///etc/passwd').ok, false);
  });

  it('sends the token from the environment and refuses redirects', async () => {
    let seen: RequestInit | undefined;

    const notifier = createWebhookNotifier({
      url: 'https://hooks.example.com/abc',
      token: 'secret-token',
      timeoutMs: 1_000,
      fetchImpl: (async (_url: string, init: RequestInit) => {
        seen = init;
        return new Response('{}', { status: 200 });
      }) as unknown as typeof fetch,
    });

    const result = await notifier.send(notification());

    assert.equal(result.delivered, true);
    assert.equal((seen?.headers as Record<string, string>)['authorization'], 'Bearer secret-token');
    assert.equal(seen?.redirect, 'error', 'a redirect could move the payload somewhere else');
  });

  it('reports a rejecting endpoint instead of throwing', async () => {
    const notifier = createWebhookNotifier({
      url: 'https://hooks.example.com/abc',
      token: undefined,
      timeoutMs: 1_000,
      fetchImpl: (async () => new Response('no', { status: 500 })) as unknown as typeof fetch,
    });

    const result = await notifier.send(notification());

    assert.equal(result.delivered, false);
    assert.match(result.reason!, /500/);
  });
});

describe('delivery', () => {
  it('one broken channel does not silence the others', async () => {
    const broken: Notifier = {
      channel: 'desktop',
      send: async () => {
        throw new Error('toast subsystem unavailable');
      },
    };

    const lines: string[] = [];
    const results = await deliver([broken, createTerminalNotifier((line) => lines.push(line))], notification());

    assert.equal(results[0]?.delivered, false);
    assert.equal(results[1]?.delivered, true, 'the working channel must still reach the user');
    assert.ok(lines.some((line) => line.includes('worth a look')));
  });

  it('reports an enabled channel that cannot be built', () => {
    const { problems } = createNotifiers({
      config: notifySchema.parse({ channels: { terminal: false, desktop: false, webhook: true } }),
      write: () => {},
      env: {},
    });

    assert.ok(problems.some((problem) => problem.includes('webhook.url')));
  });

  it('says so when nothing at all is enabled', () => {
    const { notifiers, problems } = createNotifiers({
      config: notifySchema.parse({ channels: { terminal: false, desktop: false, webhook: false } }),
      write: () => {},
      env: {},
    });

    assert.equal(notifiers.length, 0);
    assert.ok(problems.some((problem) => problem.includes('no notification channel')));
  });

  it('always tells the user where the real record is', async () => {
    const lines: string[] = [];
    await deliver([createTerminalNotifier((line) => lines.push(line))], notification());

    assert.ok(lines.some((line) => line.includes('roleeye recommend')), 'a notification must be checkable locally');
  });
});
