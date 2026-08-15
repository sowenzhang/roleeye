import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, it } from 'node:test';
import { openDatabase, type Database } from '../../src/db/database.js';
import { createRepositories, type Repositories } from '../../src/db/repositories/index.js';
import { ingestJob } from '../../src/discovery/ingest.js';
import {
  greenhouseTargetFromUrl,
  inspectForm,
  isQuestionPayload,
  parseGreenhouseQuestions,
  questionsUrl,
  saveQuestions,
  type GreenhouseJobWithQuestions,
} from '../../src/applications/form-inspect.js';
import { criteriaSchema, sourcesSchema, syncSchema } from '../../src/config/schema.js';
import { archetypesSchema } from '../../src/config/archetype-schema.js';
import type { AppConfig } from '../../src/config/load.js';
import type { DiscoveredJob } from '../../src/core/types.js';
import type { HttpClient } from '../../src/discovery/source-adapter.js';

/**
 * Form inspection: what does this application ask beyond the resume?
 *
 * Two properties are worth protecting here. The first is the split — the value
 * of the feature is the questions the resume does *not* answer, and a report
 * that leads with "First Name" is a report nobody reads twice. The second is
 * that a protected question is reported, never inferred.
 */

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

function questionsFixture(): GreenhouseJobWithQuestions {
  return JSON.parse(
    readFileSync(path.join(fixturesDir, 'greenhouse', 'questions.json'), 'utf8'),
  ) as GreenhouseJobWithQuestions;
}

function config(sources: unknown = { sources: [{ name: 'nw', type: 'greenhouse', company: 'Northwind Systems', board: 'northwind' }] }): AppConfig {
  return {
    env: {
      logLevel: 'error',
      reasoningProvider: 'none',
      embeddingProvider: 'none',
      paths: {
        root: '.',
        configDir: './config',
        profileDir: './profile',
        dataDir: './data',
        artifactsDir: './artifacts',
        exportDir: './export',
        dbPath: ':memory:',
      },
    },
    criteria: criteriaSchema.parse({}),
    sources: sourcesSchema.parse(sources),
    sync: syncSchema.parse({}),
    archetypes: archetypesSchema.parse({}),
    loadedFiles: [],
    missingFiles: [],
  };
}

function discovered(over: Partial<DiscoveredJob> = {}): DiscoveredJob {
  return {
    sourceType: 'greenhouse',
    sourceName: 'nw',
    sourceJobId: '5101378008',
    companyName: 'Northwind Systems',
    title: 'Staff Software Engineer',
    location: 'Remote - US',
    url: 'https://boards.greenhouse.io/northwind/jobs/5101378008',
    descriptionHtml: `<p>Build things. ${'Design distributed systems. '.repeat(20)}</p>`,
    ...over,
  };
}

describe('application form parsing', () => {
  it('separates what the resume answers from what it does not', () => {
    const parsed = parseGreenhouseQuestions(questionsFixture());

    const identity = parsed.filter((question) => question.kind === 'identity').map((question) => question.label);
    const documents = parsed.filter((question) => question.kind === 'document').map((question) => question.label);
    const rest = parsed.filter((question) => question.kind === 'question').map((question) => question.label);

    assert.deepEqual(identity, ['First Name', 'Last Name', 'Email', 'Phone']);
    assert.deepEqual(documents, ['Resume/CV']);
    assert.ok(rest.includes('Why this company?'));
    assert.ok(rest.some((label) => label.startsWith('Will you now or will you in the future require')));
  });

  it('reads both self-identification shapes and marks them demographic', () => {
    const parsed = parseGreenhouseQuestions(questionsFixture());
    const demographic = parsed.filter((question) => question.kind === 'demographic').map((question) => question.label);

    // `compliance[].questions` carries `fields`; `demographic_questions` carries
    // `answer_options` and no fields. Both real shapes are read off live boards.
    assert.deepEqual(demographic, ['DisabilityStatus', 'Gender', 'Race and Ethnicity']);

    const race = parsed.find((question) => question.label === 'Race and Ethnicity');
    assert.deepEqual(race?.options, ['Asian', "I don't wish to answer"]);
  });

  it('keeps the answer options a select offers', () => {
    const parsed = parseGreenhouseQuestions(questionsFixture());
    const sponsorship = parsed.find((question) => question.label.startsWith('Will you now'));

    assert.deepEqual(sponsorship?.options, ['Yes', 'No']);
    assert.equal(sponsorship?.required, true);
  });

  it('treats employer-written form text as hostile', () => {
    const parsed = parseGreenhouseQuestions(questionsFixture());
    const relocation = parsed.find((question) => question.label.startsWith('Are you open to relocation'));

    assert.ok(relocation);
    assert.ok(!relocation.label.includes('<script>'), 'markup must not survive into the label');
    assert.ok(!relocation.label.includes('alert(1)'));
    assert.ok(!(relocation.description ?? '').includes('<p>'));
  });

  it('ignores a question with no label rather than inventing one', () => {
    const parsed = parseGreenhouseQuestions({
      questions: [{ label: '   ', required: true, fields: [{ name: 'question_1', type: 'input_text' }] }],
    });

    assert.equal(parsed.length, 0);
  });

  it('reads a board and a job id from one URL, or neither', () => {
    assert.deepEqual(greenhouseTargetFromUrl('https://boards.greenhouse.io/northwind/jobs/12'), {
      board: 'northwind',
      jobId: '12',
    });
    assert.deepEqual(greenhouseTargetFromUrl('https://job-boards.greenhouse.io/northwind/jobs/12'), {
      board: 'northwind',
      jobId: '12',
    });
    assert.deepEqual(
      greenhouseTargetFromUrl('https://boards.greenhouse.io/embed/job_app?for=northwind&token=12'),
      { board: 'northwind', jobId: '12' },
    );

    // The embed form names the board in `for`, not in the path. Reading
    // `job_app` as a board — which the first version did — asks a board that
    // does not exist.
    assert.equal(greenhouseTargetFromUrl('https://boards.greenhouse.io/embed/job_app?for=northwind'), undefined);
    assert.equal(greenhouseTargetFromUrl('https://northwind.com/careers/12'), undefined);
    assert.equal(greenhouseTargetFromUrl('https://boards.greenhouse.io/northwind'), undefined);
    assert.equal(greenhouseTargetFromUrl('not a url'), undefined);
  });

  it('accepts a payload only if it carries a question list', () => {
    assert.equal(isQuestionPayload({}), false);
    assert.equal(isQuestionPayload(null), false);
    assert.equal(isQuestionPayload({ questions: 'nope' }), false);
    assert.equal(isQuestionPayload({ questions: [] }), true);
    assert.equal(isQuestionPayload({ demographic_questions: { questions: [] } }), true);
  });

  it('survives a payload whose fields are the wrong type', () => {
    const parsed = parseGreenhouseQuestions({
      questions: [{ label: 'Notice period?', fields: 'not an array' as never }],
      compliance: 'not an array' as never,
    });

    assert.deepEqual(
      parsed.map((question) => question.label),
      ['Notice period?'],
    );
  });
});

describe('application form inspection', () => {
  let db: Database;
  let repos: Repositories;

  function stubHttp(payload: unknown = questionsFixture()): HttpClient & { calls: string[] } {
    const calls: string[] = [];
    return {
      calls,
      getText: async () => '',
      getJson: async (url: string) => {
        calls.push(url);
        if (payload instanceof Error) throw payload;
        return payload as never;
      },
    };
  }

  function ingest(over: Partial<DiscoveredJob> = {}) {
    const result = ingestJob(repos, discovered(over), {
      seenAt: '2026-08-14T10:00:00.000Z',
      scanId: undefined,
      repostGapDays: 21,
      captureMode: 'full',
    });
    const job = repos.jobs.findById(result.jobId!);
    assert.ok(job);
    return job;
  }

  beforeEach(() => {
    db = openDatabase({ path: ':memory:' });
    repos = createRepositories(db);
  });

  it('asks the board this posting came from', async () => {
    const job = ingest();
    const http = stubHttp();

    const inspection = await inspectForm({ job, repos, config: config(), http });

    assert.equal(http.calls[0], questionsUrl('northwind', '5101378008'));
    assert.equal(inspection.supported, true);
    assert.equal(inspection.provider, 'greenhouse');
    assert.equal(inspection.covered.length, 5);
  });

  it('reports a protected question as unanswered instead of borrowing a similar answer', async () => {
    const job = ingest();

    // A neighbouring, differently-scoped sponsorship answer exists. It must not
    // be reached for: "similar" is not a judgement to make about somebody's
    // right to work.
    repos.answers.upsert({
      questionText: 'Do you require visa sponsorship in Canada?',
      answer: 'No',
      scope: 'jurisdiction',
      scopeValue: 'CA',
    });

    const inspection = await inspectForm({ job, repos, config: config(), http: stubHttp() });
    const sponsorship = inspection.questions.find((question) => question.label.startsWith('Will you now'));

    assert.ok(sponsorship);
    assert.equal(sponsorship.lookup.status, 'blocked-sensitive');
    assert.equal(sponsorship.lookup.answer, undefined);
  });

  it('reuses an answer the user has already given and confirmed', async () => {
    const job = ingest();
    repos.answers.upsert({ questionText: 'Why this company?', answer: 'Because of the loyalty platform work.' });

    const inspection = await inspectForm({ job, repos, config: config(), http: stubHttp() });
    const why = inspection.questions.find((question) => question.label === 'Why this company?');

    assert.equal(why?.lookup.status, 'ready');
    assert.equal(why?.lookup.answer?.answer, 'Because of the loyalty platform work.');
  });

  it('says so plainly when the provider does not publish its form', async () => {
    const job = ingest({
      sourceType: 'lever',
      sourceName: 'lv',
      url: 'https://jobs.lever.co/northwind/abc-123',
      descriptionHtml: `<p>A different role. ${'Design distributed systems. '.repeat(20)}</p>`,
    });

    const inspection = await inspectForm({ job, repos, config: config({ sources: [] }), http: stubHttp() });

    assert.equal(inspection.supported, false);
    assert.match(inspection.note ?? '', /does not publish its application form/);
    assert.equal(inspection.url, 'https://jobs.lever.co/northwind/abc-123');
  });

  it('reports a board that will not answer, without failing the command', async () => {
    const job = ingest();
    const inspection = await inspectForm({
      job,
      repos,
      config: config(),
      http: stubHttp(new Error('HTTP 404 Not Found')),
    });

    assert.equal(inspection.supported, false);
    assert.match(inspection.error ?? '', /404/);
  });

  it('never matches or stores a self-identification question', async () => {
    const job = ingest();

    const inspection = await inspectForm({ job, repos, config: config(), http: stubHttp() });

    assert.deepEqual(
      inspection.demographic.map((question) => question.label),
      ['DisabilityStatus', 'Gender', 'Race and Ethnicity'],
    );
    assert.ok(
      inspection.questions.every((question) => question.kind === 'question'),
      'EEO questions must not reach the answer bank',
    );

    saveQuestions(repos.answers, inspection);
    const stored = repos.answers.list().map((answer) => answer.questionText);
    assert.ok(!stored.includes('Gender'));
    assert.ok(!stored.includes('Race and Ethnicity'));
    assert.ok(!stored.includes('DisabilityStatus'));
  });

  it('detects self-identification from the question, not only the field name', async () => {
    const job = ingest();
    const http = stubHttp({
      questions: [
        {
          label: 'What is your sexual orientation?',
          required: false,
          fields: [{ name: 'question_14826587008', type: 'multi_value_single_select', values: [] }],
        },
      ],
    });

    const inspection = await inspectForm({ job, repos, config: config(), http });

    // A voluntary question added as an ordinary custom field carries a field
    // name of `question_<digits>`, which matches nothing. Classifying on the
    // field alone let it into the bank.
    assert.equal(inspection.questions.length, 0);
    assert.deepEqual(
      inspection.demographic.map((question) => question.label),
      ['What is your sexual orientation?'],
    );

    saveQuestions(repos.answers, inspection);
    assert.equal(repos.answers.list().length, 0);
  });

  it('refuses to ask one board about another board\'s posting', async () => {
    const job = ingest({
      // The posting URL is attacker-influenced. Pairing its job id with the
      // configured board would return a different role's questions.
      url: 'https://boards.greenhouse.io/someoneelse/jobs/999',
    });
    const http = stubHttp();

    const inspection = await inspectForm({ job, repos, config: config(), http });

    assert.equal(inspection.supported, false);
    assert.equal(http.calls.length, 0, 'no request may be made when the identity disagrees');
    assert.match(inspection.note ?? '', /refusing to ask one board about the other/);
  });

  it('reports an unreadable payload as unreadable, not as a form with no questions', async () => {
    const job = ingest();
    const inspection = await inspectForm({ job, repos, config: config(), http: stubHttp({ id: 1 }) });

    assert.equal(inspection.supported, false);
    assert.match(inspection.error ?? '', /no question list/);
  });

  it('stores unanswered questions once, and does not duplicate them on a second run', async () => {
    const job = ingest();

    const first = await inspectForm({ job, repos, config: config(), http: stubHttp() });
    const savedFirst = saveQuestions(repos.answers, first);
    assert.ok(savedFirst.created > 0);

    const second = await inspectForm({ job, repos, config: config(), http: stubHttp() });
    const savedSecond = saveQuestions(repos.answers, second);

    // A placeholder has no answer, so "did we already store this?" cannot be
    // asked of the answer. Reporting the same questions as newly stored twice
    // misstates the work still waiting for the user.
    assert.equal(savedSecond.created, 0);
    assert.equal(savedSecond.existing, savedFirst.created);

    const labels = repos.answers.list().map((answer) => answer.questionText);
    assert.equal(new Set(labels).size, labels.length, 'a stored question must not be duplicated');
    // Stored with no answer: the form asked, and nothing has been said yet.
    assert.ok(repos.answers.list().every((answer) => answer.answer === undefined));
  });

  it('does not let a long question hide a protected one past the display width', async () => {
    const job = ingest();
    const buried = `${'Tell us about your proudest engineering achievement. '.repeat(6)}Also, do you require visa sponsorship?`;
    const http = stubHttp({
      questions: [{ label: buried, required: true, fields: [{ name: 'question_1', type: 'textarea', values: [] }] }],
    });

    const inspection = await inspectForm({ job, repos, config: config(), http });
    const question = inspection.questions[0];

    assert.ok(question);
    assert.ok(question.label.length > 200, 'the stored label must not be cut to a display width');
    assert.equal(question.lookup.status, 'blocked-sensitive');
  });
});
