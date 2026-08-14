import type {
  GenerationEnvelope,
  GenerationRequest,
  ProviderCapabilities,
  ReasoningProvider,
} from './provider.js';
import { SchemaViolationError } from './provider.js';

/**
 * A provider that returns scripted responses.
 *
 * Exists so the entire evaluation pipeline — prompts, schema validation,
 * scoring, caching, budget accounting — can be tested and demonstrated without
 * a key, a network, or a bill. `roleeye evaluate --dry-run` uses it too.
 */

export type ScriptedResponder = (request: GenerationRequest<unknown>) => unknown;

export interface ScriptedProviderOptions {
  /** Response per stage, or a function computing one. */
  responses: Record<string, unknown | ScriptedResponder>;
  name?: string;
  model?: string;
  /** Simulated usage, so budget arithmetic is exercised. */
  tokensPerCall?: { input: number; output: number };
  costPerCall?: number;
}

export class ScriptedProvider implements ReasoningProvider {
  readonly name: string;
  readonly model: string;
  readonly capabilities: ProviderCapabilities = {
    structuredOutput: true,
    reportsTokenUsage: true,
    maxContextTokens: undefined,
  };

  /** Every request received, for assertions about what was actually sent. */
  readonly calls: Array<GenerationRequest<unknown>> = [];

  constructor(private readonly options: ScriptedProviderOptions) {
    this.name = options.name ?? 'scripted';
    this.model = options.model ?? 'scripted-1';
  }

  async generate<T>(request: GenerationRequest<T>): Promise<GenerationEnvelope<T>> {
    this.calls.push(request as GenerationRequest<unknown>);

    const configured = this.options.responses[request.stage];
    if (configured === undefined) {
      throw new SchemaViolationError(this.name, [`no scripted response for stage "${request.stage}"`]);
    }

    const value =
      typeof configured === 'function'
        ? (configured as ScriptedResponder)(request as GenerationRequest<unknown>)
        : configured;

    const parsed = request.schema.safeParse(value);
    if (!parsed.success) {
      throw new SchemaViolationError(
        this.name,
        parsed.error.issues.map((issue) => `${issue.path.join('.') || 'root'}: ${issue.message}`),
      );
    }

    const tokens = this.options.tokensPerCall ?? { input: 1200, output: 400 };

    return {
      data: parsed.data,
      usage: {
        inputTokens: tokens.input,
        outputTokens: tokens.output,
        requestCount: 1,
        estimatedCostUsd: this.options.costPerCall ?? 0,
      },
      finishReason: 'complete',
      model: this.model,
      provider: this.name,
      requestId: `scripted-${this.calls.length}`,
      latencyMs: 0,
      attempts: 1,
    };
  }
}
