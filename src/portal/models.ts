/**
 * Selectable reasoning models.
 *
 * The portal exists so nobody has to know a base URL, an environment variable
 * name, or a per-million-token rate. Picking a card here fills all of them in.
 *
 * Prices are list prices in USD per million tokens as published by each vendor.
 * They are only defaults written into config: spend accounting always uses the
 * numbers in the config file, so a stale figure here is editable, not baked in.
 */

export interface ModelOption {
  id: string;
  provider: 'openai' | 'ollama' | 'custom' | 'agent-cli';
  label: string;
  /** What this choice means for the user, in their terms, not ours. */
  note: string;
  baseUrl?: string;
  apiKeyEnv?: string;
  /** Executable name for `agent-cli`. */
  command?: string;
  inputPerMtok: number;
  outputPerMtok: number;
  /** Local models never leave the machine. */
  local: boolean;
  /** Approximate parameter footprint, so the hardware cost is not a surprise. */
  requires?: string;
}

export const MODEL_OPTIONS: ModelOption[] = [
  {
    id: 'copilot',
    provider: 'agent-cli',
    label: 'GitHub Copilot CLI',
    note: 'Uses the Copilot you already pay for. No API key. Runs with every tool denied, so it can only read and answer.',
    command: 'copilot',
    inputPerMtok: 0,
    outputPerMtok: 0,
    local: false,
    requires: 'copilot on PATH, ~90s per role',
  },
  {
    id: 'gpt-5-mini',
    provider: 'openai',
    label: 'GPT-5 mini',
    note: 'Cheap and accurate enough for screening. The recommended starting point.',
    baseUrl: 'https://api.openai.com/v1',
    apiKeyEnv: 'OPENAI_API_KEY',
    inputPerMtok: 0.25,
    outputPerMtok: 2,
    local: false,
  },
  {
    id: 'gpt-5',
    provider: 'openai',
    label: 'GPT-5',
    note: 'Better judgement on senior and ambiguous roles. Roughly 7x the cost.',
    baseUrl: 'https://api.openai.com/v1',
    apiKeyEnv: 'OPENAI_API_KEY',
    inputPerMtok: 1.25,
    outputPerMtok: 10,
    local: false,
  },
  {
    id: 'llama3.1:8b',
    provider: 'ollama',
    label: 'Llama 3.1 8B',
    note: 'Runs on your machine. No API key, no cost, nothing sent anywhere.',
    baseUrl: 'http://127.0.0.1:11434/v1',
    inputPerMtok: 0,
    outputPerMtok: 0,
    local: true,
    requires: '~5 GB RAM',
  },
  {
    id: 'qwen2.5:14b',
    provider: 'ollama',
    label: 'Qwen 2.5 14B',
    note: 'Local, and noticeably steadier at structured output than 8B models.',
    baseUrl: 'http://127.0.0.1:11434/v1',
    inputPerMtok: 0,
    outputPerMtok: 0,
    local: true,
    requires: '~10 GB RAM',
  },
];

/**
 * Measured on 227 real postings (docs/spend-analysis.md), after stripping.
 *
 * Extraction sees the posting; assessment sees the posting, the profile and the
 * criteria. Output is bounded by the schemas, which is why it is so much smaller
 * than input.
 */
const TOKENS_PER_EVALUATION = { input: 3_400, output: 900 };

export interface CostEstimate {
  perPosting: number;
  perHundred: number;
  local: boolean;
}

export function estimateCost(option: Pick<ModelOption, 'inputPerMtok' | 'outputPerMtok' | 'local'>, passes: number): CostEstimate {  // A third pass re-reads the assessment rather than the whole posting again.
  const factor = passes === 3 ? 1.45 : 1;
  const perPosting =
    ((TOKENS_PER_EVALUATION.input * option.inputPerMtok + TOKENS_PER_EVALUATION.output * option.outputPerMtok) /
      1_000_000) *
    factor;

  return {
    perPosting: Number(perPosting.toFixed(5)),
    perHundred: Number((perPosting * 100).toFixed(2)),
    local: option.local,
  };
}
