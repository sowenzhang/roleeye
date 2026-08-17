import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import {
  buildInstallCommand,
  buildRemoveCommand,
  buildStatusCommand,
  detectScheduler,
  mergeCrontab,
  removeFromCrontab,
  parseTime,
  TASK_NAME,
  type ScheduleCommand,
  type ScheduleSpec,
  type SchedulerKind,
} from './os-scheduler.js';

/**
 * Reading and changing the scheduled run, as data.
 *
 * `roleeye schedule status` could answer "when does this run next?", and the
 * portal could not — it told the user to "wait for the scheduled run" without
 * being able to say whether one existed. Both now go through here, so the page
 * and the terminal cannot disagree about what is installed.
 *
 * Nothing is interpreted more than it has to be. Task Scheduler prints the next
 * run time in the machine's locale; that string is passed through verbatim
 * rather than parsed into a timestamp, because a confidently wrong date is
 * worse than the operating system's own words.
 */

export interface ScheduleInfo {
  scheduler: SchedulerKind;
  taskName: string;
  installed: boolean;
  /** 24-hour HH:MM, when it can be determined. */
  at: string | undefined;
  /** Display text for the next run. Verbatim on Windows, computed on cron. */
  nextRun: string | undefined;
  /** Only set where it was computed rather than read, so it is known to be sound. */
  nextRunIso: string | undefined;
  /** The RoleEye arguments the scheduler runs, such as "run". */
  command: string | undefined;
  /** Raw scheduler output, bounded, for the user who wants to see it. */
  detail: string | undefined;
  /** The build the task runs is older than the source it was built from. */
  staleBuild?: boolean | undefined;
}

function exec(command: ScheduleCommand, input?: string): string {
  const [executable, ...args] = command.argv;
  if (!executable) throw new Error('empty scheduler command');

  return execFileSync(executable, args, {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    ...(input === undefined ? {} : { input }),
  });
}

export function readCrontab(): string {
  try {
    return execFileSync('crontab', ['-l'], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  } catch {
    // No crontab yet is a normal state, not an error.
    return '';
  }
}

/** Pulls a `Key: value` field out of `schtasks /fo LIST` output. */
export function schtasksField(output: string, field: string): string | undefined {
  for (const line of output.split(/\r?\n/)) {
    const index = line.indexOf(':');
    if (index < 0) continue;
    if (line.slice(0, index).trim().toLowerCase() !== field.toLowerCase()) continue;

    const value = line.slice(index + 1).trim();
    return value.length > 0 ? value : undefined;
  }
  return undefined;
}

/**
 * The minute and hour out of a RoleEye crontab line.
 *
 * Only the daily shape this tool installs is recognised. A user who has since
 * hand-edited their crontab into something else gets no computed next run
 * rather than a guess at one.
 */
export function parseCronLine(line: string): { minute: number; hour: number; command: string | undefined } | undefined {
  const match = /^\s*(\d{1,2})\s+(\d{1,2})\s+\*\s+\*\s+\*\s+(.*)$/.exec(line);
  if (!match?.[1] || !match[2]) return undefined;

  const minute = Number.parseInt(match[1], 10);
  const hour = Number.parseInt(match[2], 10);
  if (minute > 59 || hour > 23) return undefined;

  const rest = match[3] ?? '';
  const invocation = /dist[/\\]index\.js"?\s+([a-z-]+)/.exec(rest);

  return { minute, hour, command: invocation?.[1] };
}

/** The next local time a daily HH:MM schedule fires. */
export function nextDailyRun(hour: number, minute: number, from = new Date()): Date {
  const next = new Date(from);
  next.setHours(hour, minute, 0, 0);
  if (next.getTime() <= from.getTime()) next.setDate(next.getDate() + 1);
  return next;
}

export function readSchedule(taskName = TASK_NAME): ScheduleInfo {
  const scheduler = detectScheduler();
  const base: ScheduleInfo = {
    scheduler,
    taskName,
    installed: false,
    at: undefined,
    nextRun: undefined,
    nextRunIso: undefined,
    command: undefined,
    detail: undefined,
  };

  if (scheduler === 'cron') {
    const line = readCrontab()
      .split('\n')
      .find((entry) => entry.includes(`# ${taskName}`));

    if (!line) return base;

    const parsed = parseCronLine(line);
    if (!parsed) return { ...base, installed: true, detail: line.slice(0, 500) };

    const next = nextDailyRun(parsed.hour, parsed.minute);

    return {
      ...base,
      installed: true,
      at: `${String(parsed.hour).padStart(2, '0')}:${String(parsed.minute).padStart(2, '0')}`,
      nextRun: next.toLocaleString(),
      nextRunIso: next.toISOString(),
      command: parsed.command,
      detail: line.slice(0, 500),
    };
  }

  let output: string;
  try {
    output = exec(buildStatusCommand(taskName));
  } catch {
    // "task not found" exits non-zero, which is a normal state, not an error.
    return base;
  }

  if (output.trim().length === 0) return base;

  const nextRun = schtasksField(output, 'Next Run Time');
  const startTime = schtasksField(output, 'Start Time');
  const action = schtasksField(output, 'Task To Run');
  const invocation = action ? /dist[/\\]index\.js"?\s+([a-z-]+)/.exec(action) : undefined;

  return {
    ...base,
    installed: true,
    at: normalizeClock(startTime),
    // N/A is what Task Scheduler prints for a disabled task; it is not a time.
    nextRun: nextRun && !/^n\/?a$/i.test(nextRun) ? nextRun : undefined,
    nextRunIso: undefined,
    command: invocation?.[1],
    detail: output
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0)
      .slice(0, 20)
      .join('\n')
      .slice(0, 1500),
  };
}

/** Best effort: a clock string we cannot read is simply not reported. */
function normalizeClock(value: string | undefined): string | undefined {
  if (!value) return undefined;

  const match = /^(\d{1,2}):(\d{2})(?::\d{2})?\s*(AM|PM)?$/i.exec(value.trim());
  if (!match?.[1] || !match[2]) return undefined;

  let hour = Number.parseInt(match[1], 10);
  const meridiem = match[3]?.toUpperCase();
  if (meridiem === 'PM' && hour < 12) hour += 12;
  if (meridiem === 'AM' && hour === 12) hour = 0;

  return `${String(hour).padStart(2, '0')}:${match[2]}`;
}

export function installSchedule(spec: ScheduleSpec): ScheduleInfo {
  // Rejects a bad time before anything is written to the scheduler.
  parseTime(spec.time);

  // The scheduler runs the compiled entry point, not the TypeScript source. A
  // task installed against a missing build fails silently every morning at
  // 07:30 — the worst possible failure, because nobody is watching.
  const build = checkBuild(spec.root);
  if (!build.exists) {
    throw new Error(
      `there is no build to schedule: ${build.entry} does not exist. Run "npm run build" first, then schedule.`,
    );
  }

  const command = buildInstallCommand(spec);
  const taskName = spec.taskName ?? TASK_NAME;

  if (command.kind === 'cron' && command.cronLine) {
    exec(command, mergeCrontab(readCrontab(), command.cronLine, taskName));
  } else {
    exec(command);
  }

  const info = readSchedule(taskName);
  return build.stale ? { ...info, staleBuild: true } : info;
}

export interface BuildState {
  entry: string;
  exists: boolean;
  /** Source has been edited since the build, so the scheduled run is not this code. */
  stale: boolean;
}

/**
 * Whether the compiled entry point exists and matches the source.
 *
 * Staleness is a warning rather than a refusal: an old build still runs, and
 * refusing to schedule because a comment changed would be worse than saying so.
 * Missing is a refusal, because that one cannot work at all.
 */
export function checkBuild(root: string): BuildState {
  const entry = path.join(root, 'dist', 'index.js');
  if (!existsSync(entry)) return { entry, exists: false, stale: true };

  const builtAt = statSync(entry).mtimeMs;
  const srcDir = path.join(root, 'src');

  return { entry, exists: true, stale: existsSync(srcDir) && newestMtime(srcDir) > builtAt };
}

/** Bounded walk: a source tree is small, but a symlink loop is not. */
function newestMtime(dir: string, depth = 0): number {
  if (depth > 8) return 0;

  let newest = 0;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }

  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      newest = Math.max(newest, newestMtime(full, depth + 1));
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      try {
        newest = Math.max(newest, statSync(full).mtimeMs);
      } catch {
        // A file that vanished mid-walk is not a reason to fail.
      }
    }
  }

  return newest;
}

export function removeSchedule(taskName = TASK_NAME): { removed: boolean } {
  const command = buildRemoveCommand(taskName);

  if (command.kind === 'cron') {
    const current = readCrontab();
    if (!current.includes(`# ${taskName}`)) return { removed: false };
    exec(command, removeFromCrontab(current, taskName));
    return { removed: true };
  }

  try {
    exec(command);
    return { removed: true };
  } catch {
    return { removed: false };
  }
}
