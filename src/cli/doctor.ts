import { existsSync } from 'node:fs';
import path from 'node:path';
import { ExitCode } from '../util/errors.js';
import { pendingMigrations } from '../db/migrations/index.js';
import { registeredAdapterNames } from '../discovery/registry.js';
import { printJson, printLine, type Command, type CommandContext } from './command.js';

type CheckStatus = 'ok' | 'warn' | 'fail';

interface Check {
  name: string;
  status: CheckStatus;
  detail: string;
}

const ICON: Record<CheckStatus, string> = { ok: '✓', warn: '!', fail: '✗' };

function checkPath(name: string, target: string, required: boolean): Check {
  if (existsSync(target)) return { name, status: 'ok', detail: target };
  return {
    name,
    status: required ? 'fail' : 'warn',
    detail: `${target} (missing)`,
  };
}

/**
 * Validates the local installation without changing anything the user has to
 * undo. Reports every problem in one pass instead of failing on the first.
 */
export const doctorCommand: Command = {
  name: 'doctor',
  summary: 'Validate configuration, database, migrations, and adapters',
  usage: 'roleeye doctor [--json]',

  run(context: CommandContext) {
    const checks: Check[] = [];

    let config;
    try {
      config = context.loadConfig({ allowDefaults: true });
      checks.push({ name: 'environment', status: 'ok', detail: `root ${context.root}` });
    } catch (error) {
      checks.push({
        name: 'configuration',
        status: 'fail',
        detail: error instanceof Error ? error.message : String(error),
      });
      return report(context, checks);
    }

    for (const file of config.loadedFiles) {
      checks.push({ name: `config ${path.basename(file)}`, status: 'ok', detail: file });
    }
    for (const file of config.missingFiles) {
      const base = path.basename(file);
      const required = base === 'criteria.yaml' || base === 'sources.yaml';
      const fix =
        base === 'archetypes.yaml'
          ? 'optional until you generate resumes — create it with `roleeye resume archetypes --seed software,ai`'
          : `copy config/${base.replace('.yaml', '.example.yaml')}`;
      checks.push({
        name: `config ${base}`,
        status: required ? 'fail' : 'warn',
        detail: `${file} (missing — ${fix})`,
      });
    }

    checks.push(checkPath('data directory', config.env.paths.dataDir, false));
    checks.push(checkPath('artifacts directory', config.env.paths.artifactsDir, false));
    checks.push(checkPath('profile directory', config.env.paths.profileDir, false));

    try {
      const { db } = context.openDb();
      const pending = pendingMigrations(db);
      checks.push({ name: 'database', status: 'ok', detail: config.env.paths.dbPath });
      checks.push({
        name: 'migrations',
        status: pending.length === 0 ? 'ok' : 'warn',
        detail: pending.length === 0 ? 'up to date' : `${pending.length} pending`,
      });
    } catch (error) {
      checks.push({
        name: 'database',
        status: 'fail',
        detail: error instanceof Error ? error.message : String(error),
      });
    }

    const enabled = config.sources.sources.filter((source) => source.enabled);
    const registered = new Set(registeredAdapterNames());
    checks.push({
      name: 'sources',
      status: enabled.length > 0 ? 'ok' : 'warn',
      detail: enabled.length > 0 ? `${enabled.length} enabled` : 'no enabled sources in config/sources.yaml',
    });

    for (const source of enabled) {
      const supported = registered.has(source.type);
      checks.push({
        name: `adapter ${source.name}`,
        status: supported ? 'ok' : 'warn',
        detail: supported ? source.type : `"${source.type}" adapter not implemented yet`,
      });
    }

    checks.push({
      name: 'reasoning provider',
      status: config.env.reasoningProvider === 'none' ? 'warn' : 'ok',
      detail: `${config.env.reasoningProvider} (used from phase 3)`,
    });
    checks.push({
      name: 'embedding provider',
      status: 'ok',
      detail: `${config.env.embeddingProvider} (optional, used from phase 7)`,
    });
    checks.push({
      name: 'sync',
      status: 'ok',
      detail: config.sync.enabled ? 'enabled' : 'disabled (local only)',
    });

    return report(context, checks);
  },
};

function report(context: CommandContext, checks: Check[]) {
  const failed = checks.filter((check) => check.status === 'fail').length;
  const warned = checks.filter((check) => check.status === 'warn').length;

  if (context.json) {
    printJson(context, { ok: failed === 0, failed, warned, checks });
  } else {
    printLine(context, 'roleeye doctor');
    printLine(context);
    for (const check of checks) {
      printLine(context, `  ${ICON[check.status]} ${check.name.padEnd(26)} ${check.detail}`);
    }
    printLine(context);
    printLine(
      context,
      failed > 0
        ? `${failed} check(s) failed, ${warned} warning(s).`
        : warned > 0
          ? `All required checks passed, ${warned} warning(s).`
          : 'All checks passed.',
    );
  }

  if (failed > 0) return ExitCode.ConfigError;
  return ExitCode.Ok;
}
