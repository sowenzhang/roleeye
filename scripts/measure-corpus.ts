/**
 * Temporary measurement script: samples real public ATS boards to size the
 * evaluation corpus for the token/cost model. Not part of the product.
 */
import { parseGreenhouseBoard } from '../src/discovery/greenhouse.js';
import { normalizeDiscoveredJob } from '../src/normalize/job.js';

const BOARDS = ['airtable', 'discord', 'figma'];

const BOILERPLATE_MARKERS = [
  'equal opportunity',
  'eeo',
  'we are an equal',
  'benefits',
  'perks',
  'accommodation',
  'e-verify',
  'privacy policy',
  'applicant privacy',
  'compensation range',
  'pay transparency',
  'about us',
  'about the company',
  'our values',
  'diversity',
];

function estimateTokens(text: string): number {
  return Math.round(text.length / 4);
}

function boilerplateShare(text: string): number {
  const lines = text.split('\n');
  let boilerplateChars = 0;
  let inBoilerplate = false;

  for (const line of lines) {
    const lower = line.toLowerCase();
    if (BOILERPLATE_MARKERS.some((marker) => lower.includes(marker))) inBoilerplate = true;
    if (inBoilerplate) boilerplateChars += line.length;
  }

  return text.length === 0 ? 0 : boilerplateChars / text.length;
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[index] ?? 0;
}

const allTokens: number[] = [];
const allShares: number[] = [];
let total = 0;

for (const board of BOARDS) {
  const response = await fetch(`https://boards-api.greenhouse.io/v1/boards/${board}/jobs?content=true`, {
    headers: { 'user-agent': 'roleeye-measurement/0.1' },
  });
  if (!response.ok) {
    console.log(`${board}: HTTP ${response.status}`);
    continue;
  }

  const payload = await response.json();
  const jobs = parseGreenhouseBoard(payload, {
    name: board,
    type: 'greenhouse',
    enabled: true,
    company: board,
    board,
  });

  const tokens: number[] = [];
  const shares: number[] = [];

  for (const job of jobs) {
    const normalized = normalizeDiscoveredJob(job);
    if (normalized.descriptionText.length === 0) continue;
    tokens.push(estimateTokens(normalized.descriptionText));
    shares.push(boilerplateShare(normalized.descriptionText));
  }

  allTokens.push(...tokens);
  allShares.push(...shares);
  total += jobs.length;

  console.log(
    `${board.padEnd(10)} jobs=${String(jobs.length).padStart(4)}  ` +
      `median=${percentile(tokens, 50)}tok  p90=${percentile(tokens, 90)}tok  max=${Math.max(...tokens)}tok`,
  );
}

console.log('');
console.log(`corpus: ${total} postings from ${BOARDS.length} boards`);
console.log(`description tokens: median=${percentile(allTokens, 50)} p75=${percentile(allTokens, 75)} p90=${percentile(allTokens, 90)} p99=${percentile(allTokens, 99)}`);
console.log(`mean tokens: ${Math.round(allTokens.reduce((a, b) => a + b, 0) / allTokens.length)}`);
console.log(`estimated boilerplate share: median=${(percentile(allShares, 50) * 100).toFixed(0)}% mean=${((allShares.reduce((a, b) => a + b, 0) / allShares.length) * 100).toFixed(0)}%`);
