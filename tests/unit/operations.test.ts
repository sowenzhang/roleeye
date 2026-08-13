import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import BetterSqlite3 from 'better-sqlite3';
import { backupDatabase, backupDirectoryFor, pruneBackups } from '../../src/util/backup.js';
import { openDatabase } from '../../src/db/database.js';
import { migrations } from '../../src/db/migrations/index.js';
import { createRepositories } from '../../src/db/repositories/index.js';
import {
  buildInstallCommand,
  buildRemoveCommand,
  buildStatusCommand,
  detectScheduler,
  mergeCrontab,
  parseTime,
  removeFromCrontab,
  TASK_NAME,
} from '../../src/schedule/os-scheduler.js';
import { buildCriteriaYaml, buildSourcesYaml, parseBoardEntry } from '../../src/cli/setup.js';
import { criteriaSchema, sourcesSchema } from '../../src/config/schema.js';
import { parse } from 'yaml';

const workspaces: string[] = [];

function workspace(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'roleeye-test-'));
  workspaces.push(dir);
  return dir;
}

after(() => {
  for (const dir of workspaces) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows can hold a WAL handle briefly; a leftover temp dir is harmless.
    }
  }
});

describe('database backup', () => {
  it('produces a readable copy containing the data', () => {
    const dir = workspace();
    const dbPath = path.join(dir, 'roleeye.db');

    const db = openDatabase({ path: dbPath, backupBeforeMigrate: false });
    const repos = createRepositories(db);
    repos.companies.upsertByName('Acme Corp');
    db.close();

    const result = backupDatabase({ dbPath });
    assert.equal(result.skipped, false);
    assert.ok(existsSync(result.path));
    assert.ok(result.bytes > 0);

    const restored = new BetterSqlite3(result.path, { readonly: true });
    const row = restored.prepare('SELECT COUNT(*) AS n FROM companies').get() as { n: number };
    restored.close();

    assert.equal(row.n, 1, 'the snapshot contains the data, not an empty shell');
  });

  it('skips cleanly when there is no database yet', () => {
    const result = backupDatabase({ dbPath: path.join(workspace(), 'absent.db') });
    assert.equal(result.skipped, true);
  });

  it('keeps only the newest backups', () => {
    const dir = workspace();
    for (const stamp of ['2026-01-01', '2026-01-02', '2026-01-03', '2026-01-04']) {
      writeFileSync(path.join(dir, `roleeye-${stamp}.db`), 'x');
    }
    writeFileSync(path.join(dir, 'unrelated.txt'), 'x');

    const removed = pruneBackups(dir, 2);

    assert.equal(removed.length, 2);
    const remaining = readdirSync(dir).filter((name) => name.endsWith('.db')).sort();
    assert.deepEqual(remaining, ['roleeye-2026-01-03.db', 'roleeye-2026-01-04.db']);
    assert.ok(existsSync(path.join(dir, 'unrelated.txt')), 'unrelated files are left alone');
  });

  it('defaults to a backups directory beside the database', () => {
    assert.equal(
      backupDirectoryFor(path.join('C:', 'data', 'roleeye.db')),
      path.join(path.resolve(path.join('C:', 'data')), 'backups'),
    );
  });

  it('snapshots automatically before applying a migration', () => {
    const dir = workspace();
    const dbPath = path.join(dir, 'roleeye.db');

    // Build a database at an older schema, exactly as an earlier release left it.
    const older = new BetterSqlite3(dbPath);
    older.pragma('foreign_keys = OFF');
    older.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
    for (const migration of migrations.filter((entry) => entry.version < 4)) {
      older.exec(migration.sql);
      older
        .prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)')
        .run(migration.version, migration.name, new Date().toISOString());
    }
    older.close();

    assert.equal(existsSync(backupDirectoryFor(dbPath)), false, 'no backups before the upgrade');

    openDatabase({ path: dbPath }).close();

    const backups = readdirSync(backupDirectoryFor(dbPath)).filter((name) => name.includes('pre-migration'));
    assert.equal(backups.length, 1, 'the pending migration triggered exactly one snapshot');

    // And the snapshot holds the pre-migration schema, not the new one.
    const snapshot = new BetterSqlite3(path.join(backupDirectoryFor(dbPath), backups[0] ?? ''), { readonly: true });
    const version = snapshot.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number };
    snapshot.close();

    assert.equal(version.v, 3, 'the backup captures the state before the change');
  });
});

describe('os scheduler', () => {
  const spec = {
    time: '07:30',
    command: 'scan',
    root: path.join('C:', 'projects', 'roleeye'),
    nodePath: path.join('C:', 'Program Files', 'nodejs', 'node.exe'),
  };

  it('parses valid times and rejects invalid ones', () => {
    assert.deepEqual(parseTime('07:30'), { hours: 7, minutes: 30 });
    assert.deepEqual(parseTime('23:59'), { hours: 23, minutes: 59 });
    assert.throws(() => parseTime('24:00'), /invalid time/);
    assert.throws(() => parseTime('7pm'), /invalid time/);
  });

  it('builds a Task Scheduler command on Windows', () => {
    const command = buildInstallCommand(spec, 'win32');

    assert.equal(command.kind, 'windows');
    assert.equal(command.argv[0], 'schtasks');
    assert.ok(command.argv.includes('/create'));
    assert.ok(command.argv.includes(TASK_NAME));
    assert.ok(command.argv.includes('07:30'));
    assert.ok(command.argv.some((part) => part.includes('dist') && part.includes('scan')));
  });

  it('builds a crontab line elsewhere', () => {
    const command = buildInstallCommand(spec, 'linux');

    assert.equal(command.kind, 'cron');
    assert.match(command.cronLine ?? '', /^30 7 \* \* \* /);
    assert.match(command.cronLine ?? '', new RegExp(`# ${TASK_NAME}$`));
  });

  it('builds status and remove commands per platform', () => {
    assert.equal(buildStatusCommand(TASK_NAME, 'win32').argv[1], '/query');
    assert.equal(buildRemoveCommand(TASK_NAME, 'win32').argv[1], '/delete');
    assert.deepEqual(buildStatusCommand(TASK_NAME, 'linux').argv, ['crontab', '-l']);
  });

  it('detects the scheduler from the platform', () => {
    assert.equal(detectScheduler('win32'), 'windows');
    assert.equal(detectScheduler('darwin'), 'cron');
  });

  it('replaces its own crontab line instead of duplicating it', () => {
    const line = buildInstallCommand(spec, 'linux').cronLine ?? '';
    const existing = `0 3 * * * /usr/bin/backup.sh\n${line}\n`;

    const merged = mergeCrontab(existing, line);
    const occurrences = merged.split('\n').filter((entry) => entry.includes(TASK_NAME)).length;

    assert.equal(occurrences, 1, 'installing twice must not schedule two runs');
    assert.ok(merged.includes('/usr/bin/backup.sh'), "the user's other jobs survive");
  });

  it('removes only its own line', () => {
    const line = buildInstallCommand(spec, 'linux').cronLine ?? '';
    const existing = `0 3 * * * /usr/bin/backup.sh\n${line}\n`;

    const removed = removeFromCrontab(existing);

    assert.ok(!removed.includes(TASK_NAME));
    assert.ok(removed.includes('/usr/bin/backup.sh'));
  });
});

describe('interactive setup', () => {
  it('recognises board URLs and explicit tokens', () => {
    assert.deepEqual(parseBoardEntry('greenhouse:airtable'), {
      type: 'greenhouse',
      token: 'airtable',
      company: 'airtable',
    });
    assert.deepEqual(parseBoardEntry('https://jobs.lever.co/shieldai'), {
      type: 'lever',
      token: 'shieldai',
      company: 'shieldai',
    });
    assert.deepEqual(parseBoardEntry('jobs.ashbyhq.com/Ramp'), { type: 'ashby', token: 'Ramp', company: 'Ramp' });
    assert.equal(parseBoardEntry('https://example.com/careers'), undefined);
    assert.equal(parseBoardEntry(''), undefined);
  });

  it('generates configuration the schemas accept', () => {
    const answers = {
      titles: ['engineer', 'architect'],
      excludeTitles: ['intern'],
      countries: ['US'],
      remoteOnly: true,
      minimumSalary: 200_000,
      denyWorkday: true,
      boards: [
        { type: 'greenhouse' as const, token: 'airtable', company: 'Airtable' },
        { type: 'lever' as const, token: 'shieldai', company: 'Shield AI' },
      ],
    };

    const sources = sourcesSchema.safeParse(parse(buildSourcesYaml(answers)));
    const criteria = criteriaSchema.safeParse(parse(buildCriteriaYaml(answers)));

    assert.equal(sources.success, true, 'generated sources.yaml must load');
    assert.equal(criteria.success, true, 'generated criteria.yaml must load');
    if (!sources.success || !criteria.success) return;

    assert.equal(sources.data.sources.length, 2);
    assert.equal(sources.data.sources[1]?.type, 'lever');
    assert.deepEqual(sources.data.discovery.scope.titles?.include, ['engineer', 'architect']);
    assert.equal(criteria.data.hard_filters.minimum_base_salary?.amount, 200_000);
    assert.deepEqual(criteria.data.preferences.application_system.deny, ['workday']);
  });

  it('omits the salary filter when the user skips it', () => {
    const yaml = buildCriteriaYaml({
      titles: ['engineer'],
      excludeTitles: [],
      countries: ['US'],
      remoteOnly: false,
      minimumSalary: undefined,
      denyWorkday: false,
      boards: [],
    });

    const parsed = criteriaSchema.parse(parse(yaml));
    assert.equal(parsed.hard_filters.minimum_base_salary, undefined);
  });
});
