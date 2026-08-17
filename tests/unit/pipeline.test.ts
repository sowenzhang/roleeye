import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isPipelineStage, PIPELINE_STAGES } from '../../src/core/pipeline.js';
import { parseStages } from '../../src/portal/run-service.js';
import { compileWeights, inferImportance } from '../../src/config/schema.js';
import { BudgetGuard } from '../../src/evaluate/budget.js';
import { nextDailyRun, parseCronLine, schtasksField } from '../../src/schedule/inspect.js';

describe('pipeline stages', () => {
  it('runs stages in dependency order however they are asked for', () => {
    // Screening roles that were never fetched, or assessing roles that were
    // never screened, is a run that quietly does nothing.
    assert.deepEqual(parseStages(['evaluate', 'scan']), ['scan', 'evaluate']);
    assert.deepEqual(parseStages(['screen', 'evaluate', 'scan']), [...PIPELINE_STAGES]);
  });

  it('falls back to the whole pass rather than doing nothing', () => {
    // A caller that names only nonsense meant to run something. Silently
    // running zero stages and reporting success is the worst available answer.
    assert.deepEqual(parseStages(['nonsense']), [...PIPELINE_STAGES]);
    assert.deepEqual(parseStages([]), [...PIPELINE_STAGES]);
    assert.deepEqual(parseStages(undefined), [...PIPELINE_STAGES]);
    assert.deepEqual(parseStages('scan'), [...PIPELINE_STAGES]);
  });

  it('does not treat an arbitrary string as a stage', () => {
    assert.equal(isPipelineStage('scan'), true);
    assert.equal(isPipelineStage('constructor'), false);
    assert.equal(isPipelineStage('__proto__'), false);
    assert.equal(isPipelineStage(7), false);
  });
});

describe('schedule inspection', () => {
  it('reads the fields Task Scheduler prints, and ignores the ones it does not', () => {
    const output = [
      'Folder: \\',
      'HostName:                             DESKTOP',
      'TaskName:                             \\RoleEye Daily Scan',
      'Next Run Time:                        8/17/2026 7:30:00 AM',
      'Status:                               Ready',
      'Start Time:                           7:30:00 AM',
    ].join('\r\n');

    assert.equal(schtasksField(output, 'Next Run Time'), '8/17/2026 7:30:00 AM');
    assert.equal(schtasksField(output, 'next run time'), '8/17/2026 7:30:00 AM', 'field names are matched case-insensitively');
    assert.equal(schtasksField(output, 'Last Result'), undefined);
  });

  it('reads a daily crontab line and refuses anything else', () => {
    const line = "30 7 * * * cd '/home/x' && \"/usr/bin/node\" \"/home/x/dist/index.js\" run >> '/home/x/logs/roleeye.log' 2>&1 # RoleEye Daily Scan";
    const parsed = parseCronLine(line);

    assert.equal(parsed?.hour, 7);
    assert.equal(parsed?.minute, 30);
    assert.equal(parsed?.command, 'run');

    // A crontab the user has hand-edited into something other than the daily
    // shape this tool installs gets no computed next run, rather than a guess.
    assert.equal(parseCronLine('*/5 * * * * something # RoleEye Daily Scan'), undefined);
    assert.equal(parseCronLine('30 7 * * 1 something # RoleEye Daily Scan'), undefined);
    assert.equal(parseCronLine('99 99 * * * x'), undefined);
  });

  it('rolls a passed time to tomorrow', () => {
    const monday = new Date(2026, 7, 17, 9, 0, 0);

    const later = nextDailyRun(17, 30, monday);
    assert.equal(later.getDate(), 17);
    assert.equal(later.getHours(), 17);

    const earlier = nextDailyRun(7, 30, monday);
    assert.equal(earlier.getDate(), 18, 'a time already past today fires tomorrow');

    // Exactly now counts as passed: a schedule that reports "next run" as the
    // instant you are reading it has told you nothing.
    const exactly = nextDailyRun(9, 0, monday);
    assert.equal(exactly.getDate(), 18);
  });
});

describe('importance compiles to weights', () => {
  const total = (weights: Record<string, number>) => Object.values(weights).reduce((sum, w) => sum + w, 0);

  it('always totals exactly 100, whatever the ratings are', () => {
    // The schema refuses anything else, so a combination that does not total
    // 100 is a preference the user cannot save.
    const cases = [
      { career_direction: 5, hands_on: 5, product_customer: 5, ai_relevance: 5, technical_domain: 5, location: 5, compensation: 5 },
      { career_direction: 1, hands_on: 1, product_customer: 1, ai_relevance: 1, technical_domain: 1, location: 1, compensation: 1 },
      { career_direction: 5, hands_on: 4, product_customer: 3, ai_relevance: 2, technical_domain: 1, location: 0, compensation: 3 },
      { career_direction: 5, hands_on: 0, product_customer: 0, ai_relevance: 0, technical_domain: 0, location: 0, compensation: 0 },
    ];

    for (const importance of cases) {
      assert.equal(total(compileWeights(importance)), 100, JSON.stringify(importance));
    }
  });

  it('gives everything equal weight when nothing is rated', () => {
    // "None of this matters" cannot mean "score nothing", because then no role
    // could ever be scored at all. Equal weight is the honest reading.
    const weights = compileWeights({
      career_direction: 0, hands_on: 0, product_customer: 0, ai_relevance: 0,
      technical_domain: 0, location: 0, compensation: 0,
    });

    assert.equal(total(weights), 100);
    assert.ok(Object.values(weights).every((value) => value >= 14 && value <= 15));
  });

  it('keeps a category rated zero out of the score entirely', () => {
    const weights = compileWeights({
      career_direction: 5, hands_on: 3, product_customer: 3, ai_relevance: 3,
      technical_domain: 3, location: 0, compensation: 3,
    });

    assert.equal(weights.location, 0, 'ignoring a category means ignoring it');
    assert.equal(total(weights), 100);
    assert.ok(weights.career_direction > weights.hands_on, 'a higher rating is worth more');
  });

  it('puts the sliders back where a pre-importance file left them', () => {
    // Files written before importance existed still have to open on something
    // the user recognises as their own settings.
    const importance = inferImportance({
      career_direction: 20, hands_on: 15, product_customer: 15, ai_relevance: 15,
      technical_domain: 15, location: 10, compensation: 10,
    });

    assert.equal(importance.career_direction, 5, 'the largest weight is the highest rating');
    assert.ok(importance.location < importance.career_direction);
    assert.ok(Object.values(importance).every((value) => value >= 0 && value <= 5));

    assert.equal(inferImportance({ location: 0, career_direction: 30 }).location, 0, 'zero stays zero');
  });

  it('lets an explicit limit raise the run cap it would otherwise hit', () => {
    // The picker offers 40 while the configured default is 5. Slicing 40 roles
    // and then halting at 5 cites a limit the user has just overridden, and
    // reads as the tool ignoring them.
    const configured = {
      max_jobs_per_scan: 5,
      max_cost_per_scan_usd: 1,
      max_cost_per_month_usd: 20,
      on_exhausted: 'stop' as const,
    };

    const raised = new BudgetGuard({ ...configured, max_jobs_per_scan: 40 }, 0);
    for (let i = 0; i < 6; i += 1) raised.recordJob(0);
    assert.equal(raised.check().allowed, true, 'six roles is fine when forty were asked for');

    // The count protects time; the spend caps protect money, and no picker
    // raises those.
    const money = new BudgetGuard({ ...configured, max_jobs_per_scan: 40 }, 0);
    money.recordJob(5);
    const verdict = money.check();

    assert.equal(verdict.allowed, false);
    assert.match(String((verdict as { reason: string }).reason), /spend limit/i);
  });
});
