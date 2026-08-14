import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { z } from 'zod';
import {
  extractJson,
  ProviderError,
  SchemaViolationError,
  type GenerationEnvelope,
  type GenerationRequest,
  type ReasoningProvider,
} from './provider.js';
import { schemaInstruction } from './schema-hint.js';

const run = promisify(execFile);

/**
 * Uses an AI agent already installed on the machine as a pure reasoner.
 *
 * The user brings their own paid agent (GitHub Copilot CLI today), which
 * removes the API key that otherwise blocks anyone who is not already an
 * engineer with a model subscription.
 *
 * The critical property is what this does *not* do. The agent is invoked
 * non-interactively with every tool denied, built-in MCP servers disabled, and
 * custom instruction files ignored. It cannot read a file, run a command, or
 * reach the network on our behalf; it receives text and returns text.
 *
 * That is what makes this safe to ship now while `--yolo`-style tool use stays
 * gated (architecture.md Phase 10, `docs/vision.md` §6). An approval bypass is
 * only needed by an agent that acts, and a reasoner does not act.
 */

export interface AgentCliOptions {
  command: string;
  model: string;
  timeoutMs: number;
  /** Overrides the hardened defaults. Only for adapters to other agent CLIs. */
  baseArgs?: string[];
  /** Injected in tests. */
  exec?: (command: string, args: string[], options: { timeout: number; maxBuffer: number }) => Promise<{ stdout: string; stderr: string }>;
}

/**
 * Deny everything, then ask a question.
 *
 * `--silent` makes the CLI print only the agent's answer. Without it the output
 * carries a human summary (credits, tokens, a resume command) that has to be
 * pattern-matched off, and pattern-matching a display format is how a parser
 * breaks silently on an upgrade. The trade is that per-call token counts are no
 * longer available, which is acceptable: agent calls bill against a quota, so
 * the accounting unit is the call, not the token.
 *
 * `--no-custom-instructions` matters as much as `--deny-tool`: an agent
 * normally loads instruction files from the working directory and the user
 * profile, and those would silently join a prompt that also contains an
 * untrusted job posting.
 */
export const COPILOT_SAFE_ARGS = [
  '--silent',
  '--deny-tool=all',
  '--disable-builtin-mcps',
  '--no-custom-instructions',
  '--disallow-temp-dir',
  '--no-ask-user',
  '--log-level',
  'none',
  '--no-color',
];

/** Windows caps a command line at 32,767 characters; leave room for the flags. */
const MAX_PROMPT_CHARS = 28_000;

/** The CLI prints a human summary after the answer. It is not part of the answer. */
const TRAILER = /^(Changes|AI Credits|Tokens|Resume|Total duration|Warning:)\b/;

function stripTrailer(output: string): string {
  return output
    .split('\n')
    .filter((line) => !TRAILER.test(line.trim()))
    .join('\n');
}

/**
 * Recovers usage from the CLI's human-facing summary.
 *
 * Best effort by definition: this is a display format, not an API. When it
 * changes we report nothing rather than reporting a wrong number, because spend
 * accounting that silently drifts is worse than spend accounting that admits it
 * does not know.
 */
export function parseUsage(output: string): { inputTokens?: number; outputTokens?: number; credits?: number } {
  const result: { inputTokens?: number; outputTokens?: number; credits?: number } = {};

  const credits = /AI Credits\s+([\d.]+)/.exec(output);
  if (credits?.[1]) result.credits = Number(credits[1]);

  const tokens = /Tokens\s+\D*?([\d.]+)([km]?)\b[^\n]*?\D([\d.]+)([km]?)\s*$/im.exec(output);
  if (tokens) {
    const scale = (value: string, suffix: string): number =>
      Math.round(Number(value) * (suffix.toLowerCase() === 'k' ? 1_000 : suffix.toLowerCase() === 'm' ? 1_000_000 : 1));
    result.inputTokens = scale(tokens[1]!, tokens[2] ?? '');
    result.outputTokens = scale(tokens[3]!, tokens[4] ?? '');
  }

  return result;
}

export function createAgentCliProvider(options: AgentCliOptions): ReasoningProvider {
  const exec =
    options.exec ??
    ((command, args, opts) => run(command, args, { ...opts, windowsHide: true }) as Promise<{ stdout: string; stderr: string }>);

  const baseArgs = options.baseArgs ?? COPILOT_SAFE_ARGS;

  async function ask(prompt: string): Promise<{ text: string; usage: ReturnType<typeof parseUsage> }> {
    if (prompt.length > MAX_PROMPT_CHARS) {
      throw new ProviderError(
        options.command,
        `prompt is ${prompt.length} characters, over the ${MAX_PROMPT_CHARS} limit an agent CLI can accept on a command line`,
      );
    }

    let stdout: string;
    let stderr: string;
    try {
      // execFile, never a shell: the prompt contains untrusted posting text and
      // must never be parsed by a command interpreter.
      ({ stdout, stderr } = await exec(options.command, [...baseArgs, '-p', prompt], {
        timeout: options.timeoutMs,
        maxBuffer: 20_000_000,
      }));
    } catch (error) {
      const failure = error as { code?: string; killed?: boolean; stdout?: string; stderr?: string; message?: string };
      if (failure.killed) {
        throw new ProviderError(options.command, `agent did not answer within ${options.timeoutMs}ms`, { retryable: true });
      }
      throw new ProviderError(options.command, failure.stderr?.trim() || failure.message || 'agent CLI failed', {
        retryable: true,
      });
    }

    return { text: stripTrailer(stdout), usage: parseUsage(`${stdout}\n${stderr}`) };
  }

  return {
    name: options.command,
    model: options.model,
    capabilities: {
      structuredOutput: false,
      // Token counts come from a display string, so they are advisory.
      reportsTokenUsage: false,
      maxContextTokens: undefined,
    },

    async generate<T>(request: GenerationRequest<T>): Promise<GenerationEnvelope<T>> {
      const started = Date.now();
      const instruction = `${request.system}\n\n${request.prompt}\n\n${schemaInstruction(request.schemaName, request.schema as z.ZodTypeAny)}`;

      let attempts = 0;
      let lastIssues: string[] = [];
      let usage: ReturnType<typeof parseUsage> = {};

      // One repair attempt: agent calls are slow and consume a paid quota, so a
      // long retry loop is expensive in a way an API call is not. The retry
      // names the exact violations, because "that was wrong" is not actionable.
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const repair =
          lastIssues.length > 0
            ? `\n\nYour previous reply was rejected for: ${lastIssues.join('; ')}. Fix exactly those and reply with the JSON object only.`
            : '';

        attempts += 1;
        const answer = await ask(`${instruction}${repair}`);
        usage = answer.usage;

        const parsed = (request.schema as z.ZodType<T, z.ZodTypeDef, unknown>).safeParse(extractJson(answer.text));
        if (parsed.success) {
          return {
            data: parsed.data,
            usage: {
              inputTokens: usage.inputTokens,
              outputTokens: usage.outputTokens,
              requestCount: attempts,
              // Billed against a subscription quota, not a per-token price.
              estimatedCostUsd: undefined,
            },
            finishReason: 'complete',
            model: options.model,
            provider: options.command,
            requestId: undefined,
            latencyMs: Date.now() - started,
            attempts,
          };
        }

        lastIssues = parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`);
      }

      throw new SchemaViolationError(options.command, lastIssues);
    },
  };
}
