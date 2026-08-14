/**
 * How does search behave when the corpus stops being small?
 *
 * A developer tool, never invoked by the product or the test suite. It builds a
 * synthetic database in a temporary file and times the three operations that
 * would degrade first: a full index build, an incremental sync over an
 * unchanged corpus, and a query whose join looks up the latest evaluation per
 * job.
 *
 *   npx tsx scripts/measure-search.ts 10000
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDatabase } from '../src/db/database.js';
import { syncSearchIndex } from '../src/search/indexer.js';
import { search } from '../src/search/query.js';
import { funnel } from '../src/analytics/funnel.js';

const jobCount = Number.parseInt(process.argv[2] ?? '10000', 10);
const directory = mkdtempSync(path.join(tmpdir(), 'roleeye-bench-'));
const dbPath = path.join(directory, 'bench.db');

function time<T>(label: string, fn: () => T): T {
  const started = performance.now();
  const result = fn();
  const elapsed = performance.now() - started;
  process.stdout.write(`${label.padEnd(42)} ${elapsed.toFixed(0).padStart(7)} ms\n`);
  return result;
}

const db = openDatabase({ path: dbPath, backupBeforeMigrate: false });

const body =
  'We are looking for an engineer to design distributed systems on Kubernetes, ' +
  'operate Postgres at scale, and lead platform migrations. '.repeat(24);

time(`seed ${jobCount} jobs`, () => {
  db.transaction(() => {
    db.prepare(
      `INSERT INTO companies (id, name, normalized_name, created_at) VALUES ('co_1', 'Northwind', 'northwind', '2026-01-01T00:00:00.000Z')`,
    ).run();

    const insertJob = db.prepare(
      `INSERT INTO jobs (
         id, company_id, title, normalized_title, employment_type, work_arrangement,
         location_text, country, description_text, description_hash, has_body, fingerprint,
         in_scope, first_seen_at, last_seen_at, created_at, updated_at
       ) VALUES (
         @id, 'co_1', @title, @title, 'full_time', 'remote', 'Remote - US', 'US',
         @body, @hash, 1, @hash, 1, @seen, @seen, @seen, @seen
       )`,
    );

    const insertEvaluation = db.prepare(
      `INSERT INTO evaluations (id, job_id, created_at, decision, score, confidence, headline, content_hash, profile_hash, criteria_hash)
       VALUES (@id, @job_id, @created_at, @decision, @score, 0.8, 'headline', @id, 'p', 'k')`,
    );

    for (let index = 0; index < jobCount; index += 1) {
      const id = `job_${index.toString(16).padStart(16, '0')}`;
      const seen = new Date(Date.UTC(2026, 0, 1 + (index % 200))).toISOString();

      insertJob.run({ id, title: `Staff Platform Engineer ${index}`, body: `${body} Role ${index}.`, hash: `h${index}`, seen });

      // Every tenth role is evaluated three times, which is the shape that
      // makes "the latest verdict per role" expensive.
      if (index % 10 === 0) {
        for (let pass = 0; pass < 3; pass += 1) {
          insertEvaluation.run({
            id: `eval_${index}_${pass}`,
            job_id: id,
            created_at: new Date(Date.UTC(2026, 1, 1 + pass)).toISOString(),
            decision: pass === 2 ? 'APPLY' : 'MAYBE',
            score: 50 + pass,
          });
        }
      }
    }
  })();
});

time('first index build', () => syncSearchIndex(db, { rebuild: true }));
time('incremental sync, nothing changed', () => syncSearchIndex(db));

const keyword = time('keyword search', () => search(db, { query: 'postgres migrations' }, { skipSync: true }));
process.stdout.write(`  ${keyword.hits.length} hit(s)\n`);

const structured = time('structured search, latest verdict join', () =>
  search(db, { documentTypes: ['job-description'], decision: 'APPLY', limit: 25 }, { skipSync: true }),
);
process.stdout.write(`  ${structured.hits.length} hit(s)\n`);

const report = time('funnel', () => funnel(db));
process.stdout.write(`  discovered ${report.counts.discovered}, recommended ${report.counts.recommended}\n`);

db.close();
rmSync(directory, { recursive: true, force: true });
