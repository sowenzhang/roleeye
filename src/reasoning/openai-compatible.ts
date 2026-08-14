import { z } from 'zod';
import { redactUrl, type Logger } from '../util/logger.js';
import { schemaInstruction } from './schema-hint.js';
import {
  extractJson,
  ProviderError,
  SchemaViolationError,
  type GenerationEnvelope,
  type GenerationRequest,
  type ProviderCapabilities,
  type ReasoningProvider,
} from './provider.js';

/**
 * OpenAI-compatible chat completions.
 *
 * One implementation covers hosted OpenAI, Azure, and — importantly for a tool
 * meant to run entirely on your own machine — Ollama and llama.cpp, which both
 * serve this API shape. Choosing a local base URL keeps every posting and every
 * profile detail on the machine.
 */

export interface OpenAiCompatibleOptions {
  baseUrl: string;
  model: string;
  apiKey?: string | undefined;
  providerName?: string | undefined;
  timeoutMs?: number | undefined;
  maxRetries?: number | undefined;
  /** Per-million-token pricing, for spend accounting. */
  inputPerMTok?: number | undefined;
  outputPerMTok?: number | undefined;
  /** Native JSON mode. Local models often do better with prompt-and-parse. */
  useJsonMode?: boolean | undefined;
  logger: Logger;
  fetchImpl?: typeof fetch;
}

const responseSchema = z.object({
  id: z.string().optional(),
  model: z.string().optional(),
  choices: z
    .array(
      z.object({
        finish_reason: z.string().optional(),
        message: z.object({ content: z.string().nullable().optional() }).optional(),
      }),
    )
    .min(1),
  usage: z
    .object({
      prompt_tokens: z.number().optional(),
      completion_tokens: z.number().optional(),
    })
    .optional(),
});

function mapFinishReason(reason: string | undefined): GenerationEnvelope<unknown>['finishReason'] {
  if (reason === 'stop' || reason === undefined) return 'complete';
  if (reason === 'length' || reason === 'max_tokens') return 'length';
  if (reason === 'content_filter') return 'filtered';
  return 'complete';
}

export class OpenAiCompatibleProvider implements ReasoningProvider {
  readonly name: string;
  readonly model: string;
  readonly capabilities: ProviderCapabilities;

  private readonly options: OpenAiCompatibleOptions;
  private readonly doFetch: typeof fetch;

  constructor(options: OpenAiCompatibleOptions) {
    this.options = options;
    this.name = options.providerName ?? 'openai-compatible';
    this.model = options.model;
    this.doFetch = options.fetchImpl ?? fetch;
    this.capabilities = {
      structuredOutput: options.useJsonMode ?? true,
      reportsTokenUsage: true,
      maxContextTokens: undefined,
    };
  }

  async generate<T>(request: GenerationRequest<T>): Promise<GenerationEnvelope<T>> {
    const started = Date.now();
    const maxAttempts = (this.options.maxRetries ?? 1) + 1;

    let lastIssues: string[] = [];
    let attempt = 0;

    while (attempt < maxAttempts) {
      attempt += 1;

      const repair =
        lastIssues.length > 0
          ? `\n\nYour previous reply was rejected: ${lastIssues.join('; ')}. Reply with JSON only.`
          : '';

      const body = {
        model: this.model,
        temperature: request.temperature ?? 0,
        ...(request.maxOutputTokens ? { max_tokens: request.maxOutputTokens } : {}),
        ...(this.capabilities.structuredOutput ? { response_format: { type: 'json_object' } } : {}),
        messages: [
          { role: 'system', content: request.system },
          {
            role: 'user',
            // `json_object` mode guarantees valid JSON, not the right fields.
            // Without the shape the model invents its own key names.
            content: `${request.prompt}\n\n${schemaInstruction(request.schemaName, request.schema as z.ZodTypeAny)}${repair}`,
          },
        ],
      };

      const response = await this.post(body, request.signal);
      const parsed = responseSchema.safeParse(response.payload);

      if (!parsed.success) {
        throw new ProviderError(this.name, 'unexpected response shape from provider', { retryable: false });
      }

      const choice = parsed.data.choices[0];
      const content = choice?.message?.content ?? '';
      const candidate = extractJson(content);

      const validated = request.schema.safeParse(candidate);
      if (validated.success) {
        const inputTokens = parsed.data.usage?.prompt_tokens;
        const outputTokens = parsed.data.usage?.completion_tokens;

        return {
          data: validated.data,
          usage: {
            inputTokens,
            outputTokens,
            requestCount: attempt,
            estimatedCostUsd: this.estimateCost(inputTokens, outputTokens),
          },
          finishReason: mapFinishReason(choice?.finish_reason),
          model: parsed.data.model ?? this.model,
          provider: this.name,
          requestId: parsed.data.id,
          latencyMs: Date.now() - started,
          attempts: attempt,
        };
      }

      lastIssues = validated.error.issues.map((issue) => `${issue.path.join('.') || 'root'}: ${issue.message}`);
      this.options.logger.warn('model output failed validation', {
        stage: request.stage,
        attempt,
        issues: lastIssues.slice(0, 3),
      });
    }

    throw new SchemaViolationError(this.name, lastIssues);
  }

  private estimateCost(inputTokens: number | undefined, outputTokens: number | undefined): number | undefined {
    const { inputPerMTok, outputPerMTok } = this.options;
    if (inputPerMTok === undefined && outputPerMTok === undefined) return undefined;

    const input = ((inputTokens ?? 0) / 1_000_000) * (inputPerMTok ?? 0);
    const output = ((outputTokens ?? 0) / 1_000_000) * (outputPerMTok ?? 0);
    return Number((input + output).toFixed(6));
  }

  private async post(body: unknown, signal: AbortSignal | undefined): Promise<{ payload: unknown }> {
    const url = `${this.options.baseUrl.replace(/\/+$/, '')}/chat/completions`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 120_000);

    if (signal) signal.addEventListener('abort', () => controller.abort(), { once: true });

    try {
      const response = await this.doFetch(url, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          // A local provider needs no key; sending an empty one confuses some servers.
          ...(this.options.apiKey ? { authorization: `Bearer ${this.options.apiKey}` } : {}),
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const detail = (await response.text()).slice(0, 300);
        throw new ProviderError(this.name, `HTTP ${response.status} from ${redactUrl(url)}: ${detail}`, {
          retryable: response.status === 429 || response.status >= 500,
        });
      }

      return { payload: await response.json() };
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      const aborted = error instanceof Error && error.name === 'AbortError';
      throw new ProviderError(this.name, aborted ? 'request timed out' : String(error), { retryable: aborted });
    } finally {
      clearTimeout(timer);
    }
  }
}
