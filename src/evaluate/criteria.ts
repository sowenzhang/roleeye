import { sha256 } from '../util/hash.js';
import type { CriteriaConfig } from '../config/schema.js';

/**
 * The criteria engine.
 *
 * Its main job beyond typing is producing a *content-derived* version for the
 * evaluation cache. Relying on a hand-maintained `version:` field means a user
 * edits their salary floor, forgets to bump the number, and silently keeps
 * stale verdicts.
 */

export interface CriteriaContext {
  criteria: CriteriaConfig;
  /** Hash of everything that can change a decision. */
  hash: string;
}

/**
 * Canonical JSON: object keys sorted recursively so formatting or key order in
 * the YAML file cannot change the hash.
 */
export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value === null || typeof value !== 'object') return value;

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));

  return Object.fromEntries(entries.map(([key, entry]) => [key, canonicalize(entry)]));
}

/** Only the parts that affect a decision take part in the hash. */
export function criteriaHash(criteria: CriteriaConfig): string {
  const decisionRelevant = {
    decision_thresholds: criteria.decision_thresholds,
    weights: criteria.weights,
    hard_filters: criteria.hard_filters,
    penalties: criteria.penalties,
    preferences: criteria.preferences,
    screening: criteria.screening,
  };

  return sha256(JSON.stringify(canonicalize(decisionRelevant)));
}

export function createCriteriaContext(criteria: CriteriaConfig): CriteriaContext {
  return { criteria, hash: criteriaHash(criteria) };
}

/** Application systems the user refuses to apply through. */
export function deniedApplicationSystems(criteria: CriteriaConfig): string[] {
  const fromPreferences = criteria.preferences.application_system.deny.map((entry) => entry.toLowerCase());

  // A -100 penalty on a system is a rejection stated in a different place.
  const penalties = criteria.penalties['application_system'];
  const fromPenalties =
    typeof penalties === 'object' && penalties !== null
      ? Object.entries(penalties)
          .filter(([, value]) => typeof value === 'number' && value <= -100)
          .map(([key]) => key.toLowerCase())
      : [];

  return [...new Set([...fromPreferences, ...fromPenalties])];
}
