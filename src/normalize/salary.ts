import type { RawSalary, SalaryPeriod } from '../core/types.js';

const CURRENCY_SYMBOLS: Record<string, string> = {
  $: 'USD',
  '£': 'GBP',
  '€': 'EUR',
  '₹': 'INR',
  '¥': 'JPY',
};

const CURRENCY_CODES = new Set(['USD', 'CAD', 'GBP', 'EUR', 'INR', 'AUD', 'JPY', 'CHF', 'SGD', 'BRL', 'MXN', 'ILS']);

const PERIOD_PATTERNS: ReadonlyArray<readonly [RegExp, SalaryPeriod]> = [
  [/\bper\s+hour\b|\bhourly\b|\/\s*hr\b|\ban hour\b/i, 'hour'],
  [/\bper\s+day\b|\bdaily\b|\/\s*day\b/i, 'day'],
  [/\bper\s+week\b|\bweekly\b|\/\s*wk\b/i, 'week'],
  [/\bper\s+month\b|\bmonthly\b|\/\s*mo\b/i, 'month'],
  [/\bper\s+(year|annum)\b|\bannual(ly)?\b|\/\s*yr\b/i, 'year'],
];

const AMOUNT = String.raw`(\d[\d,.]*)\s*([kKmM])?`;

/**
 * Best-effort salary extraction from free text. Returns undefined rather than a
 * guess when the text is ambiguous: a wrong number would silently break the
 * compensation hard filter.
 */
export function parseSalary(text: string | undefined | null): RawSalary | undefined {
  if (!text) return undefined;
  const input = text.replace(/\s+/g, ' ');

  const currency = detectCurrency(input);
  const period = detectPeriod(input);

  const rangePattern = new RegExp(
    String.raw`[$£€₹¥]?\s*${AMOUNT}\s*(?:-|–|—|to|through|up to)\s*[$£€₹¥]?\s*${AMOUNT}`,
    'i',
  );
  const range = rangePattern.exec(input);
  if (range) {
    const min = toAmount(range[1], range[2]);
    const max = toAmount(range[3], range[4]);
    if (min !== undefined && max !== undefined && max >= min) {
      return build(min, max, currency, period, input);
    }
  }

  const singlePattern = new RegExp(String.raw`[$£€₹¥]\s*${AMOUNT}`, 'i');
  const single = singlePattern.exec(input);
  if (single) {
    const value = toAmount(single[1], single[2]);
    if (value !== undefined) return build(value, value, currency, period, input);
  }

  return undefined;
}

function build(
  min: number,
  max: number,
  currency: string | undefined,
  period: SalaryPeriod | undefined,
  text: string,
): RawSalary {
  const resolvedPeriod = period ?? inferPeriodFromMagnitude(min);
  return {
    min,
    max,
    currency: currency ?? 'USD',
    period: resolvedPeriod,
    text: text.slice(0, 300),
  };
}

function toAmount(raw: string | undefined, suffix: string | undefined): number | undefined {
  if (!raw) return undefined;
  const cleaned = raw.replace(/,/g, '');
  const value = Number.parseFloat(cleaned);
  if (!Number.isFinite(value) || value <= 0) return undefined;

  const multiplier = suffix?.toLowerCase() === 'k' ? 1_000 : suffix?.toLowerCase() === 'm' ? 1_000_000 : 1;
  return Math.round(value * multiplier);
}

export function detectCurrency(text: string): string | undefined {
  const code = /\b(USD|CAD|GBP|EUR|INR|AUD|JPY|CHF|SGD|BRL|MXN|ILS)\b/i.exec(text);
  if (code?.[1]) {
    const upper = code[1].toUpperCase();
    if (CURRENCY_CODES.has(upper)) return upper;
  }

  for (const [symbol, currency] of Object.entries(CURRENCY_SYMBOLS)) {
    if (text.includes(symbol)) return currency;
  }
  return undefined;
}

export function detectPeriod(text: string): SalaryPeriod | undefined {
  for (const [pattern, period] of PERIOD_PATTERNS) {
    if (pattern.test(text)) return period;
  }
  return undefined;
}

function inferPeriodFromMagnitude(amount: number): SalaryPeriod {
  if (amount < 500) return 'hour';
  if (amount < 5_000) return 'week';
  return 'year';
}

/** Normalizes any period to an annual figure for threshold comparison. */
export function toAnnual(amount: number, period: SalaryPeriod | undefined): number {
  switch (period) {
    case 'hour':
      return Math.round(amount * 2080);
    case 'day':
      return Math.round(amount * 260);
    case 'week':
      return Math.round(amount * 52);
    case 'month':
      return Math.round(amount * 12);
    default:
      return amount;
  }
}

/** Pulls a pay range out of a long description body. */
export function findSalaryInDescription(description: string | undefined): RawSalary | undefined {
  if (!description) return undefined;

  const lines = description.split('\n');
  for (const line of lines) {
    if (!/[$£€₹¥]|\b(salary|compensation|pay range|base pay|base salary)\b/i.test(line)) continue;
    const parsed = parseSalary(line);
    if (parsed) return parsed;
  }
  return undefined;
}
