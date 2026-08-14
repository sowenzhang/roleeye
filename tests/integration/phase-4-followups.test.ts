import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { openDatabase, type Database } from '../../src/db/database.js';
import { createRepositories, type Repositories } from '../../src/db/repositories/index.js';
import { ingestJob } from '../../src/discovery/ingest.js';
import { archetypesSchema } from '../../src/config/archetype-schema.js';
import { assignArchetypes } from '../../src/resume/assign.js';
import { archetypesHash } from '../../src/resume/archetypes.js';
import type { DiscoveredJob } from '../../src/core/types.js';
import { silentLogger } from '../../src/util/logger.js';

/**
 * The three findings from the Phase 4 review that were recorded and deferred
 * rather than fixed in that release.
 */

const ARCHETYPES = archetypesSchema.parse({
  archetypes: [
    { id: 'ai-platform', label: 'AI platform', titles: ['ml engineer'], skills: ['inference'] },
    { id: 'payments', label: 'Payments backend', titles: ['payments engineer'], skills: ['ledger'] },
  ],
});

function discovered(over: Partial<DiscoveredJob> = {}): DiscoveredJob {
  return {
    sourceType: 'greenhouse',
    sourceName: 'nw',
    sourceJobId: 'gh-1',
    companyName: 'Northwind',
    title: 'Senior ML Engineer',
    location: 'Remote - US',
    url: 'https://boards.greenhouse.io/nw/jobs/1',
    descriptionHtml: `<p>${'Own inference infrastructure. '.repeat(30)}</p>`,
    ...over,
  };
}

describe('phase 4 follow-ups', () => {
  let db: Database;
  let repos: Repositories;

  beforeEach(() => {
    db = openDatabase({ path: ':memory:' });
    repos = createRepositories(db);
  });

  function ingest(index: number, title = 'Senior ML Engineer'): string {
    const result = ingestJob(
      repos,
      discovered({
        sourceJobId: `gh-${index}`,
        url: `https://boards.greenhouse.io/nw/jobs/${index}`,
        title,
        // Distinct bodies: identical text under one company clusters into a
        // single logical role, which is correct behaviour and would make this
        // fixture measure the wrong thing.
        descriptionHtml: `<p>Role ${index}. ${'Own inference infrastructure. '.repeat(30)}</p>`,
      }),
      { seenAt: '2026-08-14T10:00:00.000Z', scanId: undefined, repostGapDays: 21, captureMode: 'full' },
    );
    assert.ok(result.jobId);
    return result.jobId;
  }

  describe('fact identity is scoped to the employer', () => {
    it('keeps the same sentence under two employers as two facts', () => {
      // The bullet a reviewer used: true of both jobs, and collapsing them lost
      // the second job's provenance entirely.
      const acme = repos.facts.upsertExperience({ company: 'Acme', role: 'Staff Engineer' });
      const globex = repos.facts.upsertExperience({ company: 'Globex', role: 'Senior Engineer' });
      const statement = 'Led a cross-functional platform migration.';

      const first = repos.facts.upsert({ statement, experienceId: acme.id, origin: 'import' });
      const second = repos.facts.upsert({ statement, experienceId: globex.id, origin: 'import' });

      assert.equal(first.outcome, 'created');
      assert.equal(second.outcome, 'created');
      assert.notEqual(first.fact.id, second.fact.id);
      assert.equal(repos.facts.list({}).length, 2);
      assert.deepEqual(
        repos.facts.list({}).map((fact) => fact.experienceId).sort(),
        [acme.id, globex.id].sort(),
      );
    });

    it('still reconciles a re-import rather than duplicating', () => {
      const acme = repos.facts.upsertExperience({ company: 'Acme', role: 'Staff Engineer' });
      const statement = 'Rebuilt the rewards platform.';

      repos.facts.upsert({ statement, experienceId: acme.id, origin: 'import' });
      const again = repos.facts.upsert({ statement, experienceId: acme.id, origin: 'import' });

      assert.equal(again.outcome, 'unchanged');
      assert.equal(repos.facts.list({}).length, 1);
    });

    it('adopts an unattached fact when a document supplies the employer', () => {
      // Typing a fact by hand and later importing the document it came from
      // should not leave two copies.
      const statement = 'Mentored four engineers through promotion.';
      const manual = repos.facts.upsert({ statement, origin: 'manual' });
      const acme = repos.facts.upsertExperience({ company: 'Acme', role: 'Staff Engineer' });

      const imported = repos.facts.upsert({ statement, experienceId: acme.id, origin: 'import' });

      assert.equal(imported.fact.id, manual.fact.id);
      assert.equal(repos.facts.list({}).length, 1);
      assert.equal(imported.fact.experienceId, acme.id);
    });

    it('will not guess an employer when the same words sit under two', () => {
      const acme = repos.facts.upsertExperience({ company: 'Acme', role: 'Staff Engineer' });
      const globex = repos.facts.upsertExperience({ company: 'Globex', role: 'Senior Engineer' });
      const statement = 'Led a cross-functional platform migration.';

      repos.facts.upsert({ statement, experienceId: acme.id, origin: 'import' });
      repos.facts.upsert({ statement, experienceId: globex.id, origin: 'import' });

      // Ambiguous: attaching this to either employer would credit the wrong job.
      const loose = repos.facts.upsert({ statement, origin: 'manual' });

      assert.equal(loose.outcome, 'created');
      assert.equal(loose.fact.experienceId, undefined);
    });
  });

  describe('a forced reclassification retires the correction it overrides', () => {
    it('does not let an old manual answer come back on the next run', () => {
      const jobId = ingest(1);
      const jobs = repos.jobs.list({ limit: 10 });

      assignArchetypes(repos, ARCHETYPES, jobs, { logger: silentLogger });

      repos.assignments.save({
        jobId,
        archetypeId: 'payments',
        archetypeHash: archetypesHash(ARCHETYPES),
        score: 1,
        runnerUpId: undefined,
        runnerUpScore: undefined,
        method: 'manual',
        evidence: ['assigned by hand'],
      });

      // The user changes their mind and forces a fresh decision.
      assignArchetypes(repos, ARCHETYPES, jobs, { logger: silentLogger, force: true });
      assert.equal(repos.assignments.latestForJob(jobId)?.archetypeId, 'ai-platform');

      // The next ordinary run must not resurrect the superseded correction.
      assignArchetypes(repos, ARCHETYPES, jobs, { logger: silentLogger });

      const final = repos.assignments.latestForJob(jobId);
      assert.equal(final?.archetypeId, 'ai-platform');
      assert.equal(final?.method, 'deterministic');
    });

    it('keeps a correction through an ordinary run, which is the point of it', () => {
      const jobId = ingest(1);
      const jobs = repos.jobs.list({ limit: 10 });

      assignArchetypes(repos, ARCHETYPES, jobs, { logger: silentLogger });
      repos.assignments.save({
        jobId,
        archetypeId: 'payments',
        archetypeHash: archetypesHash(ARCHETYPES),
        score: 1,
        runnerUpId: undefined,
        runnerUpScore: undefined,
        method: 'manual',
        evidence: ['assigned by hand'],
      });

      assignArchetypes(repos, ARCHETYPES, jobs, { logger: silentLogger });

      assert.equal(repos.assignments.latestForJob(jobId)?.archetypeId, 'payments');
    });

    it('lets the user correct it again after a forced run', () => {
      // One row exists per job and archetype version, so a forced run replaces
      // the correction rather than filing it beside it. What must not happen is
      // the superseded flag outliving the row and swallowing the next
      // correction — which it did until `save` cleared it.
      const jobId = ingest(1);
      const jobs = repos.jobs.list({ limit: 10 });
      const hash = archetypesHash(ARCHETYPES);

      const correct = (): void => {
        repos.assignments.save({
          jobId,
          archetypeId: 'payments',
          archetypeHash: hash,
          score: 1,
          runnerUpId: undefined,
          runnerUpScore: undefined,
          method: 'manual',
          evidence: ['assigned by hand'],
        });
      };

      correct();
      assignArchetypes(repos, ARCHETYPES, jobs, { logger: silentLogger, force: true });
      assert.equal(repos.assignments.latestForJob(jobId)?.archetypeId, 'ai-platform');

      correct();
      assignArchetypes(repos, ARCHETYPES, jobs, { logger: silentLogger });

      assert.equal(repos.assignments.latestForJob(jobId)?.archetypeId, 'payments');
      assert.equal(repos.assignments.manualForJob(jobId)?.archetypeId, 'payments');
    });
  });

  describe('classification cost', () => {
    it('does not issue a query per job', () => {
      // Measured before this change: 601 statements for 100 jobs. The work is a
      // loop over data already in memory, so the query count must not scale
      // with the corpus.
      for (let index = 0; index < 60; index += 1) {
        ingest(index, index % 2 === 0 ? 'Senior ML Engineer' : 'Payments Engineer');
      }

      const jobs = repos.jobs.list({ limit: 200 });
      assert.equal(jobs.length, 60);

      const original = db.prepare.bind(db);
      let statements = 0;
      (db as unknown as { prepare: typeof db.prepare }).prepare = ((sql: string) => {
        statements += 1;
        return original(sql);
      }) as typeof db.prepare;

      try {
        const summary = assignArchetypes(repos, ARCHETYPES, jobs, { logger: silentLogger });
        assert.equal(summary.assigned, 60);
      } finally {
        (db as unknown as { prepare: typeof db.prepare }).prepare = original;
      }

      assert.ok(
        statements < 20,
        `classification of 60 roles issued ${statements} statements; it should not scale with the corpus`,
      );
    });
  });
});
