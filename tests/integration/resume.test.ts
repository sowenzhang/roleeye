import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { openDatabase, type Database } from '../../src/db/database.js';
import { createRepositories, type Repositories } from '../../src/db/repositories/index.js';
import { ingestJob } from '../../src/discovery/ingest.js';
import { criteriaSchema, sourcesSchema, syncSchema } from '../../src/config/schema.js';
import { archetypesSchema } from '../../src/config/archetype-schema.js';
import type { AppConfig } from '../../src/config/load.js';
import type { DiscoveredJob } from '../../src/core/types.js';
import { ScriptedProvider } from '../../src/reasoning/scripted.js';
import { assignArchetypes } from '../../src/resume/assign.js';
import { importDocument, exportFacts } from '../../src/resume/import.js';
import { ResumeGenerator } from '../../src/resume/generator.js';
import { buildDelta, chooseHeadline } from '../../src/resume/delta.js';
import { readDocument } from '../../src/resume/documents.js';
import { silentLogger } from '../../src/util/logger.js';

/**
 * The Phase 4 pipeline end to end: a real `.docx` in, approved facts, one
 * resume per archetype, and documents on disk that contain only claims the
 * approved facts support.
 *
 * The `.docx` is written by the same library the product renders with and read
 * back by the one it imports with, so the round trip is exercised rather than
 * assumed.
 */

const ARCHETYPES = archetypesSchema.parse({
  archetypes: [
    {
      id: 'ai-platform',
      label: 'AI platform engineering',
      titles: ['machine learning engineer', 'ml engineer'],
      skills: ['inference', 'gpu'],
      focus: 'Serving models in production',
    },
    {
      id: 'payments',
      label: 'Payments backend',
      titles: ['payments engineer', 'backend engineer'],
      skills: ['ledger', 'settlement'],
    },
  ],
});

function discovered(over: Partial<DiscoveredJob> = {}): DiscoveredJob {
  return {
    sourceType: 'greenhouse',
    sourceName: 'northwind',
    sourceJobId: 'gh-1',
    companyName: 'Northwind Systems',
    title: 'Senior ML Engineer',
    location: 'Remote - US',
    url: 'https://boards.greenhouse.io/northwind/jobs/1',
    descriptionHtml: `<p>Serve models in production.</p><p>${'Own inference infrastructure on GPU fleets. '.repeat(20)}</p>`,
    salary: { min: 210_000, max: 260_000, currency: 'USD', period: 'year' },
    ...over,
  };
}

/** The model's answer: two honest bullets and one embellished one. */
const RESUME_RESPONSE = {
  summary: {
    text: 'Staff engineer who rebuilt the rewards platform on event-driven services.',
    fact_ids: [] as string[],
  },
  sections: [] as { experience_id: string; bullets: { text: string; fact_ids: string[] }[] }[],
  omitted: [],
};

describe('resume pipeline', () => {
  let db: Database;
  let repos: Repositories;
  let root: string;

  beforeEach(() => {
    db = openDatabase({ path: ':memory:' });
    repos = createRepositories(db);
    root = mkdtempSync(path.join(tmpdir(), 'roleeye-resume-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function config(): AppConfig {
    return {
      env: {
        logLevel: 'error',
        reasoningProvider: 'scripted',
        embeddingProvider: 'none',
        paths: {
          root,
          configDir: path.join(root, 'config'),
          profileDir: path.join(root, 'profile'),
          dataDir: path.join(root, 'data'),
          artifactsDir: path.join(root, 'artifacts'),
          exportDir: path.join(root, 'export'),
          dbPath: ':memory:',
        },
      },
      criteria: criteriaSchema.parse({}),
      sources: sourcesSchema.parse({}),
      sync: syncSchema.parse({}),
      archetypes: ARCHETYPES,
      loadedFiles: [],
      missingFiles: [],
    };
  }

  async function writeResumeDocx(file: string): Promise<void> {
    const { Document, Packer, Paragraph } = await import('docx');
    const document = new Document({
      sections: [
        {
          children: [
            new Paragraph({ text: 'Jane Doe' }),
            new Paragraph({ text: 'EXPERIENCE' }),
            new Paragraph({ text: 'Acme Corp — Staff Software Engineer (2019 – 2023)' }),
            new Paragraph({ text: '• Rebuilt the rewards platform on event-driven services.' }),
            new Paragraph({ text: '• Reduced p99 checkout latency by 43% across three regions.' }),
            new Paragraph({ text: '• Ran model inference on a fleet of GPU nodes.' }),
          ],
        },
      ],
    });

    writeFileSync(file, await Packer.toBuffer(document));
  }

  async function importResume(): Promise<string> {
    const file = path.join(root, 'resume.docx');
    await writeResumeDocx(file);
    await importDocument({ repos, logger: silentLogger, file });
    return file;
  }

  function scriptedFor(facts: { id: string; statement: string }[], experienceId: string) {
    const rewards = facts.find((fact) => /rewards platform/.test(fact.statement));
    const latency = facts.find((fact) => /p99/.test(fact.statement));

    return new ScriptedProvider({
      responses: {
        resume: {
          ...RESUME_RESPONSE,
          summary: { text: 'Rebuilt the rewards platform on event-driven services.', fact_ids: [rewards?.id ?? ''] },
          sections: [
            {
              experience_id: experienceId,
              bullets: [
                { text: 'Rebuilt the rewards platform on event-driven services.', fact_ids: [rewards?.id ?? ''] },
                { text: 'Cut p99 checkout latency by 43% across three regions.', fact_ids: [latency?.id ?? ''] },
                // The embellishment: a number nothing supports.
                { text: 'Cut infrastructure spend by 70% company-wide.', fact_ids: [latency?.id ?? ''] },
              ],
            },
          ],
        },
        delta: {
          cover_note: {
            text: 'I rebuilt the rewards platform on event-driven services, and cut p99 checkout latency by 43%.',
            fact_ids: [rewards?.id ?? '', latency?.id ?? ''],
          },
          embedded_instructions: { found: false },
        },
      },
      costPerCall: 0.02,
    });
  }

  it('imports a real .docx as draft facts that cannot be used yet', async () => {
    await importResume();

    const facts = repos.facts.list({});
    assert.equal(facts.length, 3);
    assert.ok(facts.every((fact) => fact.status === 'draft'), 'nothing is approved on import');
    assert.equal(repos.facts.approvedFacts().length, 0);
    assert.equal(repos.facts.listExperiences().length, 1);
  });

  it('refuses to generate before a human has approved anything', async () => {
    await importResume();

    const generator = new ResumeGenerator({
      config: config(),
      repos,
      provider: new ScriptedProvider({ responses: {} }),
      logger: silentLogger,
    });

    await assert.rejects(() => generator.generate('ai-platform'), /approved fact/);
  });

  it('re-importing the same document creates no duplicates and keeps approvals', async () => {
    const file = await importResume();
    repos.facts.approve(repos.facts.list({}).map((fact) => fact.id));

    await importDocument({ repos, logger: silentLogger, file });

    assert.equal(repos.facts.list({}).length, 3);
    assert.equal(repos.facts.approvedFacts().length, 3, 'a re-import must not un-approve the store');
  });

  it('returns a fact to draft when its wording is edited', async () => {
    await importResume();
    const [fact] = repos.facts.list({});
    assert.ok(fact);

    repos.facts.approve([fact.id]);
    const edited = repos.facts.editStatement(fact.id, 'Rebuilt the rewards platform on event-driven services, twice.');

    assert.equal(edited.status, 'draft', 'approval was given to the old words');
  });

  it('generates one resume per archetype and drops the claims facts do not support', async () => {
    await importResume();
    repos.facts.approve(repos.facts.list({}).map((entry) => entry.id));

    const facts = repos.facts.approvedFacts();
    const experience = repos.facts.listExperiences()[0];
    assert.ok(experience);

    const provider = scriptedFor(facts, experience.id);
    const generator = new ResumeGenerator({ config: config(), repos, provider, logger: silentLogger });

    const result = await generator.generate('ai-platform');

    assert.equal(result.outcome, 'generated');
    assert.equal(result.dropped.length, 1, 'the invented 70% claim is dropped');
    assert.match(result.dropped[0]?.problems[0]?.detail ?? '', /70%/);
    assert.equal(result.generation.validated, false, 'a generation that lost a claim is not clean');

    const markdown = readFileSync(path.join(root, 'artifacts', 'archetypes', 'ai-platform', 'resume.md'), 'utf8');
    assert.match(markdown, /Rebuilt the rewards platform/);
    assert.doesNotMatch(markdown, /70%/, 'an unsupported claim must never reach a document');
  });

  it('writes a .docx and a provenance copy, recorded with their inputs', async () => {
    await importResume();
    repos.facts.approve(repos.facts.list({}).map((entry) => entry.id));
    const experience = repos.facts.listExperiences()[0];
    assert.ok(experience);

    const generator = new ResumeGenerator({
      config: config(),
      repos,
      provider: scriptedFor(repos.facts.approvedFacts(), experience.id),
      logger: silentLogger,
    });

    const result = await generator.generate('ai-platform');
    const docx = path.join(root, 'artifacts', 'archetypes', 'ai-platform', 'resume.docx');

    assert.ok(existsSync(docx));

    // Read it back with the import reader: the document we produce must be one
    // we can also parse, and it must contain the surviving claims.
    const reread = await readDocument(docx);
    assert.match(reread.text, /Rebuilt the rewards platform/);
    assert.doesNotMatch(reread.text, /70%/);

    const artifacts = repos.artifacts.listForArchetype('ai-platform');
    assert.equal(artifacts.length, 3);
    assert.ok(artifacts.every((artifact) => artifact.generationId === result.generation.id));
    assert.ok(artifacts.every((artifact) => artifact.checksum !== undefined));

    const provenance = readFileSync(
      path.join(root, 'artifacts', 'archetypes', 'ai-platform', 'resume-provenance.md'),
      'utf8',
    );
    assert.match(provenance, /from `fact_/, 'every rendered claim names the fact it rests on');
  });

  it('does not regenerate while the inputs are unchanged, and does when they change', async () => {
    await importResume();
    repos.facts.approve(repos.facts.list({}).map((entry) => entry.id));
    const experience = repos.facts.listExperiences()[0];
    assert.ok(experience);

    const provider = scriptedFor(repos.facts.approvedFacts(), experience.id);
    const generator = new ResumeGenerator({ config: config(), repos, provider, logger: silentLogger });

    await generator.generate('ai-platform');
    const second = await generator.generate('ai-platform');
    assert.equal(second.outcome, 'current');
    assert.equal(provider.calls.length, 1, 'an unchanged resume costs nothing');

    repos.facts.upsert({ statement: 'Led the migration of settlement to a new ledger.', origin: 'manual' });
    repos.facts.approve(repos.facts.list({ status: 'draft' }).map((entry) => entry.id));

    const third = await generator.generate('ai-platform');
    assert.equal(third.outcome, 'generated', 'a changed fact set makes the resume stale');
  });

  it('performs one generation per archetype, not one per posting', async () => {
    await importResume();
    repos.facts.approve(repos.facts.list({}).map((entry) => entry.id));
    const experience = repos.facts.listExperiences()[0];
    assert.ok(experience);

    for (let index = 0; index < 12; index += 1) {
      ingestJob(
        repos,
        discovered({
          sourceJobId: `gh-${index}`,
          url: `https://boards.greenhouse.io/northwind/jobs/${index}`,
          title: index % 2 === 0 ? 'Senior ML Engineer' : 'Backend Engineer, Payments',
          descriptionHtml: `<p>Role ${index}</p><p>${'Own inference infrastructure on GPU fleets. '.repeat(20)}</p>`,
        }),
        { seenAt: '2026-08-13T10:00:00.000Z', scanId: undefined, repostGapDays: 21, captureMode: 'full' },
      );
    }

    const jobs = repos.jobs.list({ limit: 100 });
    assert.equal(jobs.length, 12);

    const summary = assignArchetypes(repos, ARCHETYPES, jobs, { logger: silentLogger });
    assert.equal(summary.modelCalls, 0, 'classification never calls a model');
    assert.equal(summary.assigned, 12);

    const provider = scriptedFor(repos.facts.approvedFacts(), experience.id);
    const generator = new ResumeGenerator({ config: config(), repos, provider, logger: silentLogger });

    await generator.generate('ai-platform');
    await generator.generate('payments');

    assert.equal(provider.calls.length, 2, '12 postings across 2 archetypes cost 2 generations');
  });

  it('keeps a manual assignment when the classifier runs again', async () => {
    const ingested = ingestJob(repos, discovered(), {
      seenAt: '2026-08-13T10:00:00.000Z',
      scanId: undefined,
      repostGapDays: 21,
      captureMode: 'full',
    });
    assert.ok(ingested.jobId);

    const jobs = repos.jobs.list({ limit: 10 });
    assignArchetypes(repos, ARCHETYPES, jobs, { logger: silentLogger });

    repos.assignments.save({
      jobId: ingested.jobId,
      archetypeId: 'payments',
      archetypeHash: repos.assignments.latestForJob(ingested.jobId)?.archetypeHash ?? '',
      score: 1,
      runnerUpId: undefined,
      runnerUpScore: undefined,
      method: 'manual',
      evidence: ['assigned by hand'],
    });

    assignArchetypes(repos, ARCHETYPES, jobs, { logger: silentLogger });

    assert.equal(repos.assignments.latestForJob(ingested.jobId)?.archetypeId, 'payments');
  });

  it('writes a per-application delta only for the posting the user chose', async () => {
    await importResume();
    repos.facts.approve(repos.facts.list({}).map((entry) => entry.id));
    const experience = repos.facts.listExperiences()[0];
    assert.ok(experience);

    const ingested = ingestJob(repos, discovered(), {
      seenAt: '2026-08-13T10:00:00.000Z',
      scanId: undefined,
      repostGapDays: 21,
      captureMode: 'full',
    });
    assert.ok(ingested.jobId);
    const job = repos.jobs.findById(ingested.jobId);
    assert.ok(job);

    const provider = scriptedFor(repos.facts.approvedFacts(), experience.id);
    const generator = new ResumeGenerator({ config: config(), repos, provider, logger: silentLogger });
    await generator.generate('ai-platform');

    assignArchetypes(repos, ARCHETYPES, [job], { logger: silentLogger });

    const delta = await buildDelta({
      config: config(),
      repos,
      provider,
      logger: silentLogger,
      job,
      force: true,
    });

    assert.equal(delta.archetypeId, 'ai-platform');
    assert.equal(delta.coverNote?.supported, true, JSON.stringify(delta.coverNote?.problems));

    const written = readFileSync(delta.artifacts[0] as string, 'utf8');
    assert.match(written, /Application delta/);
    assert.match(written, /from `fact_/);
  });

  it('takes the headline from the archetype, never from the posting', () => {
    assert.equal(chooseHeadline('Senior ML Engineer, Ranking', ['ml engineer'], 'AI platform'), 'Ml Engineer');
    assert.equal(chooseHeadline('Wizard of Light Bulb Moments', ['ml engineer'], 'AI platform'), 'AI platform');
  });

  it('exports the store as YAML that re-imports as drafts', async () => {
    await importResume();
    repos.facts.approve(repos.facts.list({}).map((entry) => entry.id));

    const file = path.join(root, 'accomplishments.yaml');
    const exported = exportFacts(repos, file);
    assert.equal(exported.facts, 3);

    const fresh = createRepositories(openDatabase({ path: ':memory:' }));
    const summary = await importDocument({ repos: fresh, logger: silentLogger, file });

    assert.equal(summary.created, 3);
    assert.equal(fresh.facts.approvedFacts().length, 0, 'approval never travels in a file');
    assert.ok(summary.warnings.some((warning) => /approved/.test(warning)));
  });

  it('refuses a file it cannot parse, and writes nothing', async () => {
    const file = path.join(root, 'broken.yaml');
    writeFileSync(file, 'experiences:\n  - company: [unclosed\n', 'utf8');

    await assert.rejects(() => importDocument({ repos, logger: silentLogger, file }), /invalid/i);
    assert.equal(repos.facts.list({}).length, 0);
  });

  it('refuses an unsupported file type by name', async () => {
    const file = path.join(root, 'resume.doc');
    writeFileSync(file, 'legacy', 'utf8');

    await assert.rejects(() => importDocument({ repos, logger: silentLogger, file }), /save as \.docx/);
  });
});
