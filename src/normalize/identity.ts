import { sha256 } from '../util/hash.js';
import { tokenize } from './text.js';

export type IdentityTier = 'source-id' | 'canonical-url' | 'fingerprint';

export interface JobIdentity {
  /** Strongest available key. Stable across scans of the same source. */
  key: string;
  tier: IdentityTier;
  /** Tier-3 key, always computed so cross-source duplicates can be detected. */
  fingerprint: string;
}

export interface IdentityInput {
  sourceType: string;
  sourceJobId?: string | undefined;
  canonicalUrl?: string | undefined;
  applyUrl?: string | undefined;
  sourceUrl: string;
  normalizedCompanyName: string;
  normalizedTitle: string;
  locationText?: string | undefined;
  descriptionText: string;
}

/**
 * Identity hierarchy from architecture.md §12. Strongest identifier wins; we
 * never merge two postings on title similarity alone.
 */
export function resolveIdentity(input: IdentityInput): JobIdentity {
  const fingerprint = computeFingerprint(input);

  const sourceJobId = input.sourceJobId?.trim();
  if (sourceJobId) {
    return { key: `src:${input.sourceType}:${sourceJobId}`, tier: 'source-id', fingerprint };
  }

  const url = input.canonicalUrl ?? input.applyUrl ?? input.sourceUrl;
  if (url) {
    return { key: `url:${url}`, tier: 'canonical-url', fingerprint };
  }

  return { key: `fp:${fingerprint}`, tier: 'fingerprint', fingerprint };
}

/**
 * Company + title + location + a content fingerprint. Tolerates whitespace and
 * punctuation edits but changes when the posting body materially changes.
 */
export function computeFingerprint(input: {
  normalizedCompanyName: string;
  normalizedTitle: string;
  locationText?: string | undefined;
  descriptionText: string;
}): string {
  const location = normalizeLocationKey(input.locationText);
  const content = descriptionFingerprint(input.descriptionText);
  return sha256([input.normalizedCompanyName, input.normalizedTitle, location, content].join('|'));
}

export function normalizeLocationKey(locationText: string | undefined): string {
  if (!locationText) return '';
  return locationText
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Hash of the first 400 significant tokens of the body. */
export function descriptionFingerprint(description: string): string {
  const tokens = tokenize(description).slice(0, 400);
  return sha256(tokens.join(' '));
}

/**
 * Company + title + content, without location.
 *
 * Used to recognise that two postings advertise the same role: the same job
 * listed on two ATS providers, or one role opened in several locations. Location
 * is deliberately excluded because it belongs to the posting, not the role.
 * Requires a body — an empty description would cluster unrelated roles.
 */
export function computeClusterKey(input: {
  normalizedCompanyName: string;
  normalizedTitle: string;
  descriptionText: string;
}): string | undefined {
  if (input.descriptionText.trim().length === 0) return undefined;

  return sha256(
    [input.normalizedCompanyName, input.normalizedTitle, descriptionFingerprint(input.descriptionText)].join('|'),
  );
}

/** Exact-content hash, used to detect that a posting changed. */
export function descriptionHash(description: string): string {
  return sha256(description.trim());
}
