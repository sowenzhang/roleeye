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

const AMOUNT = String.raw`(\d[\d,]*(?:\.\d+)?)\s*([kKmMbB]|bn|billion|million|thousand)?`;

/** Money that is explicitly not compensation. Postings are full of it. */
const NON_COMPENSATION_CONTEXT =
  /\b(valuation|valued|funding|funded|raised|revenue|arr|market cap|investment|invested|contract|deal|budget|assets|portfolio|fund|round)\b/i;

/** Phrases that mark a figure as pay for this role. */
const PAY_CONTEXT =
  /\b(salary|salaries|compensation|pay|paid|wage|earnings|remuneration|base|hourly rate|annual rate|per hour|per year|per annum|annually|hourly|otr|ote)\b/i;

/** Plausibility bounds in USD-equivalent terms; scaled per currency below. */
const BOUNDS: Record<SalaryPeriod, { min: number; max: number }> = {
  hour: { min: 2, max: 2_000 },
  day: { min: 20, max: 20_000 },
  week: { min: 100, max: 100_000 },
  month: { min: 300, max: 500_000 },
  year: { min: 5_000, max: 10_000_000 },
};

/**
 * Order-of-magnitude multipliers for currencies whose unit is far smaller than
 * a dollar. Without them a genuine ¥12,000,000 salary is discarded as
 * implausible.
 */
const CURRENCY_SCALE: Record<string, number> = {
  JPY: 150,
  INR: 90,
  KRW: 1_300,
  IDR: 16_000,
  VND: 25_000,
  HUF: 350,
  CLP: 950,
  COP: 4_000,
  NGN: 1_500,
  ISK: 140,
};

const SALARY_KEYWORD = /\b(salary|salaries|compensation|pay|paid|base|wage|rate|earn|remuneration|package|range)\b/i;

function isPlausible(amount: number, period: SalaryPeriod, currency: string | undefined): boolean {
  const scale = CURRENCY_SCALE[(currency ?? 'USD').toUpperCase()] ?? 1;
  const bounds = BOUNDS[period];
  return amount >= bounds.min * scale && amount <= bounds.max * scale;
}

/**
 * Requires pay wording close to the figure rather than anywhere in the text.
 *
 * "We raised a $5M seed round. Salary is competitive." contains a pay keyword,
 * but not next to the only number in the sentence.
 */
function hasNearbyPayContext(text: string, matchIndex: number, matchLength: number): boolean {
  const before = text.slice(Math.max(0, matchIndex - 60), matchIndex);
  const after = text.slice(matchIndex + matchLength, matchIndex + matchLength + 60);

  if (NON_COMPENSATION_CONTEXT.test(before) || NON_COMPENSATION_CONTEXT.test(after)) return false;
  return PAY_CONTEXT.test(before) || PAY_CONTEXT.test(after);
}

/** Two adjacent four-digit years read as a range; "2015 to 2026" is not a salary. */
function looksLikeYearRange(min: number, max: number): boolean {
  const isYear = (value: number): boolean => Number.isInteger(value) && value >= 1900 && value <= 2100;
  return isYear(min) && isYear(max);
}

/**
 * Best-effort salary extraction from free text. Returns undefined rather than a
 * guess when the text is ambiguous: a wrong number would silently break the
 * compensation hard filter, and a description is full of unrelated numbers
 * ("founded in 2015", "5 to 8 years of experience", "team of 10-15").
 *
 * A match therefore requires explicit monetary evidence — a currency symbol or
 * code, or a k/m magnitude suffix — and the result must be plausible for its
 * period.
 */
export function parseSalary(text: string | undefined | null): RawSalary | undefined {
  if (!text) return undefined;
  const input = text.replace(/\s+/g, ' ');

  // Valuations, funding rounds, and contract values are money, not pay. The
  // range and single-figure branches re-check this near the actual match, so a
  // posting may still state a real salary in a different sentence.
  const currency = detectCurrency(input);
  const period = detectPeriod(input);
  const hasKeyword = SALARY_KEYWORD.test(input);

  const rangePattern = new RegExp(
    String.raw`([$£€₹¥])?\s*${AMOUNT}\s*(?:-|–|—|to|through|up to)\s*([$£€₹¥])?\s*${AMOUNT}`,
    'i',
  );
  const range = rangePattern.exec(input);

  if (range) {
    const [, symbol1, raw1, suffix1, symbol2, raw2, suffix2] = range;
    const min = toAmount(raw1, suffix1);
    const max = toAmount(raw2, suffix2);

    const monetary = Boolean(symbol1 ?? symbol2 ?? suffix1 ?? suffix2) || (currency !== undefined && hasKeyword);
    const contextOk =
      !NON_COMPENSATION_CONTEXT.test(input) || hasNearbyPayContext(input, range.index, range[0].length);

    if (
      monetary &&
      contextOk &&
      min !== undefined &&
      max !== undefined &&
      max >= min &&
      !looksLikeYearRange(min, max)
    ) {
      const built = build(min, max, currency, period, input);
      if (built) return built;
    }
  }

  // A single figure needs a currency symbol in front of it and pay wording next
  // to it: "$12.7B valuation" and "raised $5M ... salary is competitive" are
  // both money, neither is this role's pay.
  const singlePattern = new RegExp(String.raw`([$£€₹¥])\s*${AMOUNT}`, 'i');
  const single = singlePattern.exec(input);
  if (single && hasNearbyPayContext(input, single.index, single[0].length)) {
    const value = toAmount(single[2], single[3]);
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
): RawSalary | undefined {
  const resolvedPeriod = period ?? inferPeriodFromMagnitude(min, currency);
  if (!isPlausible(min, resolvedPeriod, currency) || !isPlausible(max, resolvedPeriod, currency)) return undefined;

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

  const normalized = (suffix ?? '').toLowerCase();
  const multiplier =
    normalized === 'k' || normalized === 'thousand'
      ? 1_000
      : normalized === 'm' || normalized === 'million'
        ? 1_000_000
        : normalized === 'b' || normalized === 'bn' || normalized === 'billion'
          ? 1_000_000_000
          : 1;

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

function inferPeriodFromMagnitude(amount: number, currency?: string | undefined): SalaryPeriod {
  const scale = CURRENCY_SCALE[(currency ?? 'USD').toUpperCase()] ?? 1;
  if (amount < 500 * scale) return 'hour';
  if (amount < 5_000 * scale) return 'week';
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
    // Require a currency marker or an explicit pay phrase on the line itself.
    if (!/[$£€₹¥]|\b(salary|compensation|pay range|pay scale|base pay|base salary|hourly rate)\b/i.test(line)) {
      continue;
    }
    const parsed = parseSalary(line);
    if (parsed) return parsed;
  }
  return undefined;
}
