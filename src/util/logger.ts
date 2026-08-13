/**
 * Structured, redacting logger.
 *
 * Secrets must never reach logs (agent.md security rules), so every message and
 * context value passes through the redactor before it is written.
 */

export const LOG_LEVELS = ['error', 'warn', 'info', 'debug'] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

const LEVEL_RANK: Record<LogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

export type LogContext = Record<string, unknown>;

export interface Logger {
  error(message: string, context?: LogContext): void;
  warn(message: string, context?: LogContext): void;
  info(message: string, context?: LogContext): void;
  debug(message: string, context?: LogContext): void;
  child(context: LogContext): Logger;
}

export function isLogLevel(value: string): value is LogLevel {
  return (LOG_LEVELS as readonly string[]).includes(value);
}

const SENSITIVE_KEY = /(pass|secret|token|key|auth|cookie|credential|session)/i;

const SENSITIVE_PATTERNS: readonly RegExp[] = [
  /\b(?:sk|ghp|ghs|gho|github_pat|xox[abps])[-_][A-Za-z0-9_-]{16,}\b/g,
  /\bBearer\s+[A-Za-z0-9._-]{12,}\b/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

export const REDACTED = '[redacted]';

export function redactString(value: string): string {
  let out = value;
  for (const pattern of SENSITIVE_PATTERNS) {
    out = out.replace(pattern, REDACTED);
  }
  return out;
}

export function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[depth-limit]';
  if (typeof value === 'string') return redactString(value);
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Error) {
    return { name: value.name, message: redactString(value.message) };
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactValue(entry, depth + 1));
  }
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SENSITIVE_KEY.test(key) ? REDACTED : redactValue(entry, depth + 1);
  }
  return out;
}

export interface LoggerOptions {
  level: LogLevel;
  json: boolean;
  stream?: NodeJS.WritableStream;
  context?: LogContext;
}

function formatText(level: LogLevel, message: string, context: LogContext): string {
  const time = new Date().toISOString();
  const entries = Object.entries(context);
  const suffix =
    entries.length === 0
      ? ''
      : ' ' + entries.map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`).join(' ');
  return `${time} ${level.toUpperCase().padEnd(5)} ${message}${suffix}`;
}

export function createLogger(options: LoggerOptions): Logger {
  const stream = options.stream ?? process.stderr;
  const baseContext = options.context ?? {};

  const write = (level: LogLevel, message: string, context?: LogContext): void => {
    if (LEVEL_RANK[level] > LEVEL_RANK[options.level]) return;

    const merged = { ...baseContext, ...(context ?? {}) };
    const safeContext = redactValue(merged) as LogContext;
    const safeMessage = redactString(message);

    const line = options.json
      ? JSON.stringify({ time: new Date().toISOString(), level, message: safeMessage, ...safeContext })
      : formatText(level, safeMessage, safeContext);

    stream.write(line + '\n');
  };

  return {
    error: (message, context) => write('error', message, context),
    warn: (message, context) => write('warn', message, context),
    info: (message, context) => write('info', message, context),
    debug: (message, context) => write('debug', message, context),
    child: (context) => createLogger({ ...options, context: { ...baseContext, ...context } }),
  };
}

/** Logger that discards everything. Useful in tests. */
export const silentLogger: Logger = {
  error: () => {},
  warn: () => {},
  info: () => {},
  debug: () => {},
  child: () => silentLogger,
};
