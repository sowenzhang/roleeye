import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { sha256 } from '../util/hash.js';
import { normalizeWhitespace } from '../normalize/text.js';

/**
 * The user's career profile, prepared for a model.
 *
 * agent.md requires passing only the minimum context and never sending personal
 * contact details. That is enforced here rather than left to prompt authors:
 * emails, phone numbers, and street addresses are stripped before the text can
 * reach a provider, local or hosted.
 */

export interface CareerProfile {
  /** Redacted text safe to send. */
  text: string;
  /** Hash of the redacted text, for cache keys. */
  hash: string;
  exists: boolean;
  path: string;
  redactions: number;
}

const EMAIL = /\b[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}\b/gi;
const PHONE = /(\+?\d{1,3}[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g;
const STREET = /\b\d{1,5}\s+[A-Z][a-z]+\s+(street|st|avenue|ave|road|rd|drive|dr|lane|ln|boulevard|blvd)\b\.?/gi;
const URL_HANDLE = /\bhttps?:\/\/\S+/gi;

const MAX_PROFILE_CHARS = 12_000;

export function redactProfile(text: string): { text: string; redactions: number } {
  let redactions = 0;
  const count = (): string => {
    redactions += 1;
    return '[removed]';
  };

  const cleaned = text
    .replace(EMAIL, count)
    .replace(PHONE, count)
    .replace(STREET, count)
    .replace(URL_HANDLE, count);

  return { text: normalizeWhitespace(cleaned), redactions };
}

export function loadCareerProfile(profileDir: string): CareerProfile {
  const file = path.join(profileDir, 'career-profile.md');

  if (!existsSync(file)) {
    return { text: '', hash: sha256(''), exists: false, path: file, redactions: 0 };
  }

  const raw = readFileSync(file, 'utf8');
  const { text, redactions } = redactProfile(raw);
  const capped = text.length > MAX_PROFILE_CHARS ? `${text.slice(0, MAX_PROFILE_CHARS)}\n[truncated]` : text;

  return { text: capped, hash: sha256(capped), exists: true, path: file, redactions };
}
