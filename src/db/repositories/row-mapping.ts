/** SQLite returns null for absent values; the domain model uses undefined. */
export function fromDb<T>(value: T | null | undefined): T | undefined {
  return value === null || value === undefined ? undefined : value;
}

/** better-sqlite3 rejects undefined bind parameters. */
export function toDb<T>(value: T | undefined): T | null {
  return value === undefined ? null : value;
}

export function toDbBool(value: boolean | undefined): number | null {
  if (value === undefined) return null;
  return value ? 1 : 0;
}
