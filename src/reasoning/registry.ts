import { DEFAULT_BASE_URLS, type ReasoningConfig } from '../config/reasoning-schema.js';
import { ConfigError } from '../util/errors.js';
import type { Logger } from '../util/logger.js';
import { createAgentCliProvider } from './agent-cli.js';
import { OpenAiCompatibleProvider } from './openai-compatible.js';
import type { ReasoningProvider } from './provider.js';

/**
 * Builds the configured provider.
 *
 * Keys come from the environment, never from a config file the portal writes,
 * so a credential cannot end up in a YAML file that gets shared or committed.
 */

export interface ProviderFactoryOptions {
  config: ReasoningConfig;
  logger: Logger;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}

export function describeProvider(config: ReasoningConfig): string {
  if (config.provider === 'none') return 'none configured';
  if (config.provider === 'agent-cli') return `agent CLI · ${config.command} · ${config.model}`;
  const base = config.base_url ?? DEFAULT_BASE_URLS[config.provider] ?? '(no base url)';
  return `${config.provider} · ${config.model} · ${base}`;
}

/** True when the provider runs on this machine and no data leaves it. */
export function isLocalProvider(config: ReasoningConfig): boolean {
  if (config.provider === 'ollama') return true;

  // The subprocess is local; the model behind it is not. Claiming otherwise
  // would be the most misleading thing this file could say.
  if (config.provider === 'agent-cli') return false;
  if (config.provider !== 'custom') return false;

  try {
    const host = new URL(config.base_url ?? '').hostname;
    return host === '127.0.0.1' || host === 'localhost' || host === '::1';
  } catch {
    return false;
  }
}

export function createProvider(options: ProviderFactoryOptions): ReasoningProvider | undefined {
  const { config, logger } = options;
  const env = options.env ?? process.env;

  if (config.provider === 'none') return undefined;

  if (config.provider === 'agent-cli') {
    return createAgentCliProvider({
      command: config.command,
      model: config.model,
      // Measured: 98s for one extraction pass against a real posting. An agent
      // CLI starts a session and carries a large system prompt, so API-shaped
      // timeouts abort work that would have succeeded.
      timeoutMs: Math.max(config.timeout_ms, 300_000),
    });
  }

  const baseUrl = config.base_url ?? DEFAULT_BASE_URLS[config.provider];
  if (!baseUrl) {
    throw new ConfigError(`reasoning.base_url is required for provider "${config.provider}"`);
  }

  const apiKey = env[config.api_key_env];

  // A local model needs no key; a hosted one without a key fails confusingly
  // later, so say so now.
  if (!apiKey && !isLocalProvider(config)) {
    throw new ConfigError(
      `no API key found in ${config.api_key_env}. Set it in .env, or switch reasoning.provider to "ollama" to run locally.`,
    );
  }

  return new OpenAiCompatibleProvider({
    baseUrl,
    model: config.model,
    apiKey,
    providerName: config.provider,
    timeoutMs: config.timeout_ms,
    inputPerMTok: config.pricing.input_per_mtok,
    outputPerMTok: config.pricing.output_per_mtok,
    // Local runtimes are less reliable with native JSON mode.
    useJsonMode: config.provider !== 'ollama',
    logger,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  });
}
