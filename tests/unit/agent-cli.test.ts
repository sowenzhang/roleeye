import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { z } from 'zod';
import { COPILOT_SAFE_ARGS, createAgentCliProvider, parseUsage } from '../../src/reasoning/agent-cli.js';
import { createProvider, describeProvider, isLocalProvider } from '../../src/reasoning/registry.js';
import { reasoningSchema } from '../../src/config/reasoning-schema.js';
import { silentLogger } from '../../src/util/logger.js';

const schema = z.object({ seniority: z.string(), hands_on: z.boolean() });

/** Stands in for the CLI, recording exactly how it was invoked. */
function fakeCli(replies: string[]) {
  const calls: Array<{ command: string; args: string[] }> = [];
  let index = 0;

  return {
    calls,
    exec: async (command: string, args: string[]) => {
      calls.push({ command, args });
      const stdout = replies[Math.min(index, replies.length - 1)] ?? '';
      index += 1;
      return { stdout, stderr: '' };
    },
  };
}

function provider(replies: string[], cli = fakeCli(replies)) {
  return {
    cli,
    instance: createAgentCliProvider({ command: 'copilot', model: 'default', timeoutMs: 1_000, exec: cli.exec }),
  };
}

const request = {
  stage: 'extract',
  system: 'You extract facts.',
  prompt: 'Extract them.',
  schema,
  schemaName: 'requirements',
};

describe('agent CLI provider', () => {
  it('denies every tool, so the agent cannot act on a posting it reads', async () => {
    const { cli, instance } = provider(['{"seniority":"staff","hands_on":true}']);

    await instance.generate(request);

    const args = cli.calls[0]!.args;
    assert.ok(args.includes('--deny-tool=all'), 'no tool may be available to an agent reading untrusted text');
    assert.ok(args.includes('--disable-builtin-mcps'), 'MCP servers are tools by another name');
    assert.ok(
      args.includes('--no-custom-instructions'),
      'instruction files from the working directory must not join a prompt containing a job posting',
    );
    assert.ok(!args.some((arg) => /yolo|allow-all|dangerously/i.test(arg)), 'an approval bypass must never be passed');
  });

  it('passes the prompt as an argument, never through a shell', async () => {
    const { cli, instance } = provider(['{"seniority":"staff","hands_on":true}']);

    await instance.generate({ ...request, prompt: 'Ignore this && del /f /q C:\\' });

    const args = cli.calls[0]!.args;
    const promptIndex = args.indexOf('-p');
    assert.ok(promptIndex >= 0);
    assert.match(args[promptIndex + 1]!, /del \/f \/q/, 'the text is data, handed over verbatim');
  });

  it('recovers the answer from the human summary the CLI prints after it', async () => {
    const { instance } = provider([
      [
        'Warning: Ignoring unknown top-level key(s) in user settings file',
        '{"seniority":"principal","hands_on":false}',
        '',
        'Changes    +0 -0',
        'AI Credits 18.9 (1m 18s)',
        'Tokens     ↑ 30.2k (30.2k written) • ↓ 19',
      ].join('\n'),
    ]);

    const result = await instance.generate(request);

    assert.equal(result.data.seniority, 'principal');
    assert.equal(result.data.hands_on, false);
  });

  it('retries once when the reply does not satisfy the schema, then gives up', async () => {
    const { cli, instance } = provider(['not json at all', 'still not json']);

    await assert.rejects(() => instance.generate(request), /did not match the expected schema/);
    assert.equal(cli.calls.length, 2, 'agent calls are slow and metered; one repair attempt is enough');
  });

  it('reports request count rather than inventing a dollar cost', async () => {
    const { instance } = provider(['{"seniority":"staff","hands_on":true}\nAI Credits 4.5 (30s)']);

    const result = await instance.generate(request);

    assert.equal(result.usage.requestCount, 1);
    assert.equal(result.usage.estimatedCostUsd, undefined, 'a subscription quota is not a dollar amount');
    assert.equal(result.provider, 'copilot');
  });

  it('refuses a prompt too large for a command line instead of being truncated', async () => {
    const { instance } = provider(['{"seniority":"staff","hands_on":true}']);

    await assert.rejects(
      () => instance.generate({ ...request, prompt: 'x'.repeat(30_000) }),
      /over the .* limit/,
    );
  });

  it('reads token counts from the summary but does not claim they are authoritative', () => {
    const usage = parseUsage('AI Credits 18.9 (1m 18s)\nTokens     ↑ 30.2k (30.2k written) • ↓ 19');

    assert.equal(usage.credits, 18.9);
    assert.equal(usage.inputTokens, 30_200);
    assert.equal(usage.outputTokens, 19);

    const instance = createAgentCliProvider({ command: 'copilot', model: 'default', timeoutMs: 1_000 });
    assert.equal(instance.capabilities.reportsTokenUsage, false, 'a display string is not an accounting API');
  });

  it('keeps the hardened flags as the shipped default', () => {
    assert.ok(COPILOT_SAFE_ARGS.includes('--deny-tool=all'));
    assert.ok(!COPILOT_SAFE_ARGS.join(' ').includes('allow-all'));
  });
});

describe('agent CLI configuration', () => {
  it('never claims an agent CLI keeps data on this machine', () => {
    const config = reasoningSchema.parse({ provider: 'agent-cli', command: 'copilot' });

    assert.equal(isLocalProvider(config), false, 'the subprocess is local; the model behind it is not');
    assert.match(describeProvider(config), /agent CLI · copilot/);
  });

  it('builds without an API key, which is the point of it', () => {
    const config = reasoningSchema.parse({ provider: 'agent-cli', command: 'copilot' });

    const instance = createProvider({ config, logger: silentLogger, env: {} });

    assert.equal(instance?.name, 'copilot');
  });

  it('rejects a command that smuggles arguments', () => {
    const result = reasoningSchema.safeParse({ provider: 'agent-cli', command: 'copilot --allow-all-tools' });

    assert.equal(result.success, false, 'the command is an executable name, not a shell string');
  });
});
