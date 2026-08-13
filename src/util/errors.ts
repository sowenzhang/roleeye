/**
 * Process exit codes. Commands must be scriptable, so failures are
 * distinguishable without parsing output.
 */
export const ExitCode = {
  Ok: 0,
  UnexpectedError: 1,
  UsageError: 2,
  ConfigError: 3,
  NotFound: 4,
  CompletedWithWarnings: 5,
} as const;

export type ExitCodeValue = (typeof ExitCode)[keyof typeof ExitCode];

export class RoleEyeError extends Error {
  readonly exitCode: ExitCodeValue;
  readonly details: Record<string, unknown> | undefined;

  constructor(message: string, exitCode: ExitCodeValue, details?: Record<string, unknown>) {
    super(message);
    this.name = new.target.name;
    this.exitCode = exitCode;
    this.details = details;
  }
}

export class UsageError extends RoleEyeError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, ExitCode.UsageError, details);
  }
}

export class ConfigError extends RoleEyeError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, ExitCode.ConfigError, details);
  }
}

export class NotFoundError extends RoleEyeError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, ExitCode.NotFound, details);
  }
}

/** A source failure that must not abort an entire scan. */
export class SourceError extends RoleEyeError {
  readonly sourceName: string;

  constructor(sourceName: string, message: string, details?: Record<string, unknown>) {
    super(message, ExitCode.CompletedWithWarnings, details);
    this.sourceName = sourceName;
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return String(error);
}
