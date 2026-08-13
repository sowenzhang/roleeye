/** All timestamps are stored as ISO-8601 UTC strings for portable SQLite sorting. */
export type IsoTimestamp = string;

export function nowIso(): IsoTimestamp {
  return new Date().toISOString();
}

export function toIso(value: Date | string | number | null | undefined): IsoTimestamp | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toISOString();
}

export function daysBetween(a: IsoTimestamp, b: IsoTimestamp): number {
  const ms = Math.abs(new Date(b).getTime() - new Date(a).getTime());
  return ms / 86_400_000;
}

export function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}
