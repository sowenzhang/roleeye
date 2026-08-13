import { createHash, randomBytes } from 'node:crypto';

export function sha256(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

export function shortHash(input: string, length = 12): string {
  return sha256(input).slice(0, length);
}

/**
 * Job IDs are derived from the identity key rather than random, so re-ingesting
 * the same posting into a fresh database produces the same ID. That keeps
 * artifact paths and exports stable.
 */
export function deriveJobId(identityKey: string): string {
  return `job_${shortHash(identityKey, 16)}`;
}

export function deriveCompanyId(normalizedName: string): string {
  return `co_${shortHash(normalizedName, 12)}`;
}

export function randomId(prefix: string): string {
  return `${prefix}_${randomBytes(8).toString('hex')}`;
}
