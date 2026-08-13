import path from 'node:path';

/**
 * OS scheduler integration.
 *
 * RoleEye is meant to run unattended on the user's own machine, so scheduling
 * is a first-class feature rather than a documentation footnote. Commands are
 * built as data and can be printed instead of executed, because installing a
 * scheduled task is exactly the kind of thing a user wants to inspect first.
 */

export const TASK_NAME = 'RoleEye Daily Scan';

export type SchedulerKind = 'windows' | 'cron';

export interface ScheduleSpec {
  /** 24-hour local time, HH:MM. */
  time: string;
  /** RoleEye arguments the scheduler should run, e.g. "scan". */
  command: string;
  root: string;
  nodePath: string;
  taskName?: string | undefined;
}

export interface ScheduleCommand {
  kind: SchedulerKind;
  /** Executable plus arguments, ready to spawn without a shell. */
  argv: string[];
  /** Copy-pasteable form for the user. */
  display: string;
  /** The crontab line, on cron systems. */
  cronLine?: string | undefined;
}

export function detectScheduler(platform: NodeJS.Platform = process.platform): SchedulerKind {
  return platform === 'win32' ? 'windows' : 'cron';
}

export function parseTime(value: string): { hours: number; minutes: number } {
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(value.trim());
  if (!match?.[1] || !match[2]) {
    throw new Error(`invalid time "${value}"; expected 24-hour HH:MM, for example 07:30`);
  }
  return { hours: Number.parseInt(match[1], 10), minutes: Number.parseInt(match[2], 10) };
}

/** The command line that runs RoleEye from the project directory. */
export function runLine(spec: ScheduleSpec): string {
  const entry = path.join(spec.root, 'dist', 'index.js');
  return `"${spec.nodePath}" "${entry}" ${spec.command}`;
}

export function buildInstallCommand(
  spec: ScheduleSpec,
  platform: NodeJS.Platform = process.platform,
): ScheduleCommand {
  const kind = detectScheduler(platform);
  const { hours, minutes } = parseTime(spec.time);
  const taskName = spec.taskName ?? TASK_NAME;
  const at = `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;

  if (kind === 'windows') {
    const argv = ['schtasks', '/create', '/tn', taskName, '/tr', runLine(spec), '/sc', 'daily', '/st', at, '/f'];
    return { kind, argv, display: argv.map(quoteForDisplay).join(' ') };
  }

  const logFile = path.join(spec.root, 'logs', 'roleeye.log');
  const cronLine = `${minutes} ${hours} * * * cd '${spec.root}' && ${runLine(spec)} >> '${logFile}' 2>&1 # ${taskName}`;

  return { kind, argv: ['crontab', '-'], display: cronLine, cronLine };
}

export function buildRemoveCommand(
  taskName = TASK_NAME,
  platform: NodeJS.Platform = process.platform,
): ScheduleCommand {
  const kind = detectScheduler(platform);

  if (kind === 'windows') {
    const argv = ['schtasks', '/delete', '/tn', taskName, '/f'];
    return { kind, argv, display: argv.map(quoteForDisplay).join(' ') };
  }

  return { kind, argv: ['crontab', '-'], display: `remove the line tagged "# ${taskName}" from your crontab` };
}

export function buildStatusCommand(
  taskName = TASK_NAME,
  platform: NodeJS.Platform = process.platform,
): ScheduleCommand {
  const kind = detectScheduler(platform);

  if (kind === 'windows') {
    const argv = ['schtasks', '/query', '/tn', taskName, '/v', '/fo', 'LIST'];
    return { kind, argv, display: argv.map(quoteForDisplay).join(' ') };
  }

  return { kind, argv: ['crontab', '-l'], display: 'crontab -l' };
}

function quoteForDisplay(part: string): string {
  return /[\s"]/.test(part) ? `"${part.replace(/"/g, '\\"')}"` : part;
}

/** Adds or replaces the RoleEye line in an existing crontab. */
export function mergeCrontab(existing: string, cronLine: string, taskName = TASK_NAME): string {
  const marker = `# ${taskName}`;
  const kept = existing
    .split('\n')
    .filter((line) => !line.includes(marker))
    .filter((line) => line.trim().length > 0);

  return [...kept, cronLine, ''].join('\n');
}

export function removeFromCrontab(existing: string, taskName = TASK_NAME): string {
  const marker = `# ${taskName}`;
  const kept = existing
    .split('\n')
    .filter((line) => !line.includes(marker))
    .filter((line) => line.trim().length > 0);

  return kept.length > 0 ? `${kept.join('\n')}\n` : '';
}
