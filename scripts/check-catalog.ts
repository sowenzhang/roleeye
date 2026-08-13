/**
 * Re-verifies every catalog token against its live provider.
 *
 * A guessed token is worse than no token: the user adds a company, the scan
 * finds nothing, and they conclude the tool is broken. Run this before adding
 * entries, and periodically — companies do migrate between ATS providers.
 *
 *   npm run catalog:check
 */
import { CATALOG } from '../src/portal/catalog.js';
import { boardUrl } from '../src/discovery/greenhouse.js';
import { postingsUrl } from '../src/discovery/lever.js';
import { jobBoardUrl } from '../src/discovery/ashby.js';

const endpoint = (type: string, token: string): string =>
  type === 'greenhouse' ? boardUrl(token) : type === 'lever' ? postingsUrl(token) : jobBoardUrl(token);

let healthy = 0;
const broken: string[] = [];

for (const entry of CATALOG) {
  try {
    const response = await fetch(endpoint(entry.type, entry.token), {
      headers: { 'user-agent': 'roleeye-catalog-check/0.1' },
    });

    if (!response.ok) {
      broken.push(`${entry.company} (${entry.type}:${entry.token}) - HTTP ${response.status}`);
      continue;
    }

    const payload = (await response.json()) as unknown;
    const count = Array.isArray(payload) ? payload.length : ((payload as { jobs?: unknown[] }).jobs?.length ?? 0);

    if (count === 0) {
      broken.push(`${entry.company} (${entry.type}:${entry.token}) - board reachable but empty`);
      continue;
    }

    healthy += 1;
    console.log(`  ok    ${entry.company.padEnd(22)} ${String(count).padStart(4)} roles`);
  } catch (error) {
    broken.push(`${entry.company} (${entry.type}:${entry.token}) - ${String(error)}`);
  }

  // Politeness: these are other people's servers.
  await new Promise((resolve) => setTimeout(resolve, 150));
}

console.log(`\n${healthy} of ${CATALOG.length} catalog entries verified.`);

if (broken.length > 0) {
  console.log('\nNeeds attention:');
  for (const line of broken) console.log(`  ${line}`);
  process.exitCode = 1;
}
