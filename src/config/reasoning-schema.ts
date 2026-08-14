import { z } from 'zod';

/**
 * Which model runs the reasoning, and what it costs.
 *
 * `ollama` is a first-class option, not an afterthought: a local model keeps
 * every posting and every profile detail on the machine, which is the whole
 * premise of the tool. Pricing lives here so spend accounting never hard-codes
 * a number that will be wrong next quarter.
 */
export const reasoningSchema = z
  .object({
    /** `none` disables evaluation entirely; screening still works. */
    provider: z.enum(['none', 'openai', 'ollama', 'custom', 'agent-cli']).default('none'),
    model: z.string().default('gpt-5-mini'),
    /**
     * The agent CLI to invoke for `agent-cli`.
     *
     * A bare executable name resolved on PATH, never a shell string: this is
     * passed to execFile without a shell, so it cannot carry arguments.
     */
    command: z
      .string()
      .regex(/^[a-z0-9][a-z0-9._-]*$/i, 'command must be a plain executable name, such as "copilot"')
      .default('copilot'),
    /** Required for `ollama` and `custom`; defaulted for `openai`. */
    base_url: z.string().url().optional(),
    /** Environment variable holding the key. The key itself is never stored here. */
    api_key_env: z.string().default('OPENAI_API_KEY'),
    /**
     * 2 = assess with a skeptical section. 3 = a separate adversarial pass.
     * Two correlated prompts to the same model are not two reviewers, so the
     * third pass must earn its cost.
     */
    passes: z.union([z.literal(2), z.literal(3)]).default(2),
    max_output_tokens: z.number().int().positive().default(1600),
    timeout_ms: z.number().int().positive().default(120_000),
    pricing: z
      .object({
        input_per_mtok: z.number().nonnegative().default(0),
        output_per_mtok: z.number().nonnegative().default(0),
      })
      .default({ input_per_mtok: 0, output_per_mtok: 0 }),
  })
  .strict()
  .default({
    provider: 'none',
    model: 'gpt-5-mini',
    command: 'copilot',
    api_key_env: 'OPENAI_API_KEY',
    passes: 2,
    max_output_tokens: 1600,
    timeout_ms: 120_000,
    pricing: { input_per_mtok: 0, output_per_mtok: 0 },
  });

export type ReasoningConfig = z.infer<typeof reasoningSchema>;

export const DEFAULT_BASE_URLS: Record<string, string> = {
  openai: 'https://api.openai.com/v1',
  ollama: 'http://127.0.0.1:11434/v1',
};
