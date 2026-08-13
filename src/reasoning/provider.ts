import type { z } from 'zod';

/**
 * The model boundary.
 *
 * Deliberately *not* shaped as product operations like `evaluateJob`. Phase 3b
 * alone needs extraction and assessment, phase 4 needs resume tailoring, and
 * phase 7 needs query answering; an interface enumerating those would have to
 * change every time. Instead this exposes one primitive — generate a value that
 * conforms to a schema — and returns an envelope carrying everything the caller
 * needs for accounting, retries, and diagnosis.
 */

export interface ProviderUsage {
  inputTokens: number | undefined;
  outputTokens: number | undefined;
  /** Providers billed per request rather than per token report this instead. */
  requestCount: number;
  estimatedCostUsd: number | undefined;
}

export type FinishReason = 'complete' | 'length' | 'filtered' | 'error';

export interface GenerationEnvelope<T> {
  data: T;
  usage: ProviderUsage;
  finishReason: FinishReason;
  model: string;
  provider: string;
  requestId: string | undefined;
  latencyMs: number;
  /** Attempts made, including schema-repair retries. */
  attempts: number;
}

export interface GenerationRequest<T> {
  /** Identifies the pipeline stage for spend accounting. */
  stage: string;
  /** Operator instructions. Never contains third-party text. */
  system: string;
  /** The task, with any untrusted content already fenced. */
  prompt: string;
  schema: z.ZodType<T>;
  /** Names the schema in the prompt and in cache keys. */
  schemaName: string;
  maxOutputTokens?: number | undefined;
  temperature?: number | undefined;
  signal?: AbortSignal | undefined;
}

export interface ProviderCapabilities {
  /** Native structured output, as opposed to prompt-and-parse. */
  structuredOutput: boolean;
  /** Per-token pricing is unavailable for some providers, e.g. subscription CLIs. */
  reportsTokenUsage: boolean;
  maxContextTokens: number | undefined;
}

export interface ReasoningProvider {
  readonly name: string;
  readonly model: string;
  readonly capabilities: ProviderCapabilities;

  generate<T>(request: GenerationRequest<T>): Promise<GenerationEnvelope<T>>;
}

export class ProviderError extends Error {
  readonly provider: string;
  readonly retryable: boolean;
  readonly requestId: string | undefined;

  constructor(provider: string, message: string, options: { retryable?: boolean; requestId?: string } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.provider = provider;
    this.retryable = options.retryable ?? false;
    this.requestId = options.requestId;
  }
}

/** Thrown when output cannot be made to satisfy the schema. */
export class SchemaViolationError extends ProviderError {
  readonly issues: string[];

  constructor(provider: string, issues: string[]) {
    super(provider, `model output did not match the expected schema: ${issues.join('; ')}`);
    this.name = 'SchemaViolationError';
    this.issues = issues;
  }
}

/**
 * Extracts a JSON object from model output.
 *
 * Models wrap JSON in prose or fences even when told not to. Recovering it is
 * cheaper and more reliable than another round trip, but the result is still
 * schema-validated before it is trusted.
 */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();

  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  const candidate = fenced?.[1]?.trim() ?? trimmed;

  try {
    return JSON.parse(candidate);
  } catch {
    // Fall through to brace matching.
  }

  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(candidate.slice(start, end + 1));
    } catch {
      return undefined;
    }
  }

  return undefined;
}
