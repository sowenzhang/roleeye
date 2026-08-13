import { createInterface } from 'node:readline/promises';

/**
 * Minimal prompt helpers for interactive setup.
 *
 * A first run should not require reading the architecture document and writing
 * YAML by hand, but the prompts must stay skippable: every command needs a
 * non-interactive path for scripting and scheduling.
 */

export interface Prompter {
  ask(question: string, fallback?: string): Promise<string>;
  confirm(question: string, fallback: boolean): Promise<boolean>;
  close(): void;
}

export function createPrompter(input = process.stdin, output = process.stdout): Prompter {
  const rl = createInterface({ input, output });

  return {
    async ask(question, fallback) {
      const suffix = fallback ? ` [${fallback}]` : '';
      const answer = (await rl.question(`${question}${suffix}: `)).trim();
      return answer.length > 0 ? answer : (fallback ?? '');
    },
    async confirm(question, fallback) {
      const suffix = fallback ? ' [Y/n]' : ' [y/N]';
      const answer = (await rl.question(`${question}${suffix}: `)).trim().toLowerCase();
      if (answer.length === 0) return fallback;
      return answer.startsWith('y');
    },
    close() {
      rl.close();
    },
  };
}

/** Splits a comma or semicolon separated answer into clean entries. */
export function parseList(answer: string): string[] {
  return answer
    .split(/[,;]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

export function parseAmount(answer: string): number | undefined {
  const cleaned = answer.replace(/[^0-9.km]/gi, '');
  if (cleaned.length === 0) return undefined;

  const multiplier = /k$/i.test(cleaned) ? 1_000 : /m$/i.test(cleaned) ? 1_000_000 : 1;
  const value = Number.parseFloat(cleaned.replace(/[km]$/i, ''));

  return Number.isFinite(value) && value > 0 ? Math.round(value * multiplier) : undefined;
}
