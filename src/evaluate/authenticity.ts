import type { ScreeningConfig } from '../config/screening-schema.js';
import type { JobRecord } from '../db/repositories/jobs.js';
import type { SourcePosting } from '../db/repositories/source-postings.js';
import type { JobSeenEvent } from '../core/types.js';
import { daysBetween, type IsoTimestamp } from '../util/time.js';

/**
 * Deterministic authenticity screening.
 *
 * Four independent dimensions rather than one label, because a posting can be
 * stale *and* evergreen *and* fine, or fresh *and* fraudulent. Collapsing that
 * into a single verdict hides the disagreement.
 *
 * Nothing here calls a model. Fraud markers are visible on first sight;
 * longevity and reposting need history, so those dimensions answer `unknown`
 * until the posting has been observed long enough to have an opinion.
 */

export type Freshness = 'current' | 'stale' | 'unknown';
export type HiringIntent = 'specific' | 'evergreen' | 'unknown';
export type FraudRisk = 'low' | 'medium' | 'high';
export type Provenance = 'verified' | 'unverified' | 'suspicious';

export interface AuthenticitySignal {
  code: string;
  dimension: 'freshness' | 'hiringIntent' | 'fraudRisk' | 'provenance';
  severity: 'info' | 'concern' | 'alarm';
  detail: string;
}

export interface AuthenticityVerdict {
  freshness: Freshness;
  hiringIntent: HiringIntent;
  fraudRisk: FraudRisk;
  provenance: Provenance;
  signals: AuthenticitySignal[];
  /** True when the pipeline must stop for this role. */
  blocked: boolean;
}

export interface AuthenticityInput {
  job: JobRecord;
  postings: SourcePosting[];
  events: JobSeenEvent[];
  /** Distinct companies advertising this exact body. */
  duplicateCompanyCount: number;
  now: IsoTimestamp;
}

/**
 * Scam markers, worth detecting from the very first sighting.
 *
 * These patterns are deliberately narrow. A false alarm on a legitimate role is
 * far more damaging than a missed scam: the user stops trusting every verdict
 * the tool produces. The first draft matched "wire harnesses ... equipment
 * procurement" in an avionics job description, so every payment pattern now
 * requires the *applicant* to be the one paying.
 */
const FRAUD_PATTERNS: ReadonlyArray<{ code: string; pattern: RegExp; detail: string; severity: 'concern' | 'alarm' }> = [
  {
    code: 'payment-requested',
    pattern:
      /\b(you|applicants?|candidates?|the successful applicant)\b[^.!?]{0,60}\b(must|will need to|are required to|have to|should)\b[^.!?]{0,40}\b(pay|purchase|buy|cover the cost|remit|send)\b/i,
    detail: 'the posting asks the applicant to pay for something',
    severity: 'alarm',
  },
  {
    code: 'upfront-fee',
    pattern:
      /\b(registration|processing|application|training|onboarding|placement|starter[- ]kit|security[- ]deposit)\s+fee\b|\bnon-?refundable fee\b|\bfee (is )?required (to|before)\b/i,
    detail: 'mentions a fee the applicant pays to be considered',
    severity: 'alarm',
  },
  {
    code: 'own-expense',
    pattern: /\bat (your|the applicant'?s) own expense\b|\byou (will )?(be responsible for|must) (purchase|buy)\b/i,
    detail: 'requires the applicant to buy equipment themselves',
    severity: 'concern',
  },
  {
    code: 'check-deposit',
    pattern: /\b(cashier'?s? check|money order)\b[^.!?]{0,80}\b(deposit|cash|wire|send)\b|\bdeposit the check\b/i,
    detail: 'mentions depositing a check, a common advance-fee scam',
    severity: 'alarm',
  },
  {
    code: 'crypto-payment',
    pattern: /\b(salary|payment|wages|paid)\b[^.!?]{0,40}\b(bitcoin|crypto(currency)?|usdt|ethereum)\b/i,
    detail: 'proposes paying wages in cryptocurrency',
    severity: 'alarm',
  },
  {
    code: 'messaging-app-contact',
    pattern:
      /\b(contact|message|text|reach|interview|apply|respond)\b[^.!?]{0,40}\b(via|on|through|using)\b[^.!?]{0,20}\b(telegram|whatsapp|signal|wechat)\b/i,
    detail: 'directs applicants to a messaging app instead of a hiring process',
    severity: 'alarm',
  },
  {
    code: 'free-email-contact',
    pattern: /\b(send|email|forward|submit)\b[^.!?]{0,50}\b[a-z0-9._%+-]+@(gmail|yahoo|hotmail|outlook|aol)\.[a-z]{2,}\b/i,
    detail: 'asks applicants to email a free personal address rather than an ATS',
    severity: 'concern',
  },
  {
    code: 'sensitive-data-early',
    pattern:
      /\b(provide|send|include|submit|share)\b[^.!?]{0,60}\b(social security number|ssn|bank account (number|details)|routing number|passport number)\b/i,
    detail: 'requests government or banking identifiers in the posting itself',
    severity: 'alarm',
  },
  {
    code: 'no-interview-offer',
    pattern: /\bno interview (is )?(required|needed)\b|\bhired immediately\b|\bguaranteed (income|job|position)\b/i,
    detail: 'promises work without a hiring process',
    severity: 'concern',
  },
];

function scanFraud(job: JobRecord): AuthenticitySignal[] {
  if (!job.hasBody) return [];

  const signals: AuthenticitySignal[] = [];
  for (const marker of FRAUD_PATTERNS) {
    if (marker.pattern.test(job.descriptionText)) {
      signals.push({
        code: marker.code,
        dimension: 'fraudRisk',
        severity: marker.severity,
        detail: marker.detail,
      });
    }
  }
  return signals;
}

function scanProvenance(input: AuthenticityInput, config: ScreeningConfig): AuthenticitySignal[] {
  const signals: AuthenticitySignal[] = [];
  const { job, postings } = input;

  const unidentified = postings.filter((posting) => !posting.applicationSystem);
  if (unidentified.length === postings.length && postings.length > 0) {
    signals.push({
      code: 'unknown-application-system',
      dimension: 'provenance',
      severity: 'info',
      detail: 'the application route is not a recognised ATS',
    });
  }

  if (input.duplicateCompanyCount >= config.duplicate_company_threshold) {
    signals.push({
      code: 'duplicated-across-companies',
      dimension: 'provenance',
      severity: 'alarm',
      detail: `the same description appears under ${input.duplicateCompanyCount} different companies`,
    });
  } else if (input.duplicateCompanyCount > 1) {
    signals.push({
      code: 'duplicated-across-companies',
      dimension: 'provenance',
      severity: 'concern',
      detail: `the same description also appears under ${input.duplicateCompanyCount - 1} other company name(s)`,
    });
  }

  if (job.hasBody && job.descriptionText.length < config.minimum_description_chars) {
    signals.push({
      code: 'thin-description',
      dimension: 'provenance',
      severity: 'concern',
      detail: `the description is only ${job.descriptionText.length} characters`,
    });
  }

  return signals;
}

/**
 * Longevity and reposting.
 *
 * These are the signals only a system that keeps history can produce, and they
 * are also the ones that mean nothing on day one, so they stay silent until the
 * observation window has passed.
 */
function scanHistory(
  input: AuthenticityInput,
  config: ScreeningConfig,
): { signals: AuthenticitySignal[]; observed: number; matured: boolean } {
  const observed = daysBetween(input.job.firstSeenAt, input.now);
  const matured = observed >= config.observation_window_days;
  const signals: AuthenticitySignal[] = [];

  if (!matured) {
    signals.push({
      code: 'insufficient-history',
      dimension: 'freshness',
      severity: 'info',
      detail: `observed for ${Math.floor(observed)} of ${config.observation_window_days} days needed to judge longevity`,
    });
    return { signals, observed, matured };
  }

  const openFor = daysBetween(input.job.firstSeenAt, input.job.closedAt ?? input.now);
  if (openFor >= config.stale_after_days) {
    signals.push({
      code: 'long-open',
      dimension: 'freshness',
      severity: 'concern',
      detail: `open for ${Math.round(openFor)} days`,
    });
  }

  const reposts = input.events.filter((event) => event.eventType === 'reposted');
  if (reposts.length >= config.evergreen_repost_threshold) {
    signals.push({
      code: 'frequent-reposts',
      dimension: 'hiringIntent',
      severity: 'concern',
      detail: `reposted ${reposts.length} times since first seen`,
    });
  }

  const unchangedReposts = reposts.filter((event) => (event.detail ?? '').includes('source job id changed'));
  if (unchangedReposts.length > 0) {
    signals.push({
      code: 'rotating-requisition-id',
      dimension: 'hiringIntent',
      severity: 'concern',
      detail: 'the requisition id changed while the description stayed the same',
    });
  }

  return { signals, observed, matured };
}

/** Combines the signals into one value per dimension. */
export function screenAuthenticity(input: AuthenticityInput, config: ScreeningConfig): AuthenticityVerdict {
  if (!config.enabled) {
    return {
      freshness: 'unknown',
      hiringIntent: 'unknown',
      fraudRisk: 'low',
      provenance: 'unverified',
      signals: [],
      blocked: false,
    };
  }

  const fraudSignals = scanFraud(input.job);
  const provenanceSignals = scanProvenance(input, config);
  const history = scanHistory(input, config);
  const signals = [...fraudSignals, ...provenanceSignals, ...history.signals];

  const alarms = signals.filter((signal) => signal.severity === 'alarm');
  const concerns = signals.filter((signal) => signal.severity === 'concern');

  const fraudAlarms = alarms.filter((signal) => signal.dimension === 'fraudRisk');
  const fraudConcerns = concerns.filter((signal) => signal.dimension === 'fraudRisk');
  const fraudRisk: FraudRisk = fraudAlarms.length > 0 ? 'high' : fraudConcerns.length > 0 ? 'medium' : 'low';

  const provenanceAlarms = alarms.filter((signal) => signal.dimension === 'provenance');
  const provenanceConcerns = concerns.filter((signal) => signal.dimension === 'provenance');
  const provenance: Provenance =
    provenanceAlarms.length > 0
      ? 'suspicious'
      : provenanceConcerns.length > 0
        ? 'unverified'
        : input.postings.some((posting) => posting.applicationSystem)
          ? 'verified'
          : 'unverified';

  const freshness: Freshness = !history.matured
    ? 'unknown'
    : signals.some((signal) => signal.code === 'long-open')
      ? 'stale'
      : 'current';

  const hiringIntent: HiringIntent = !history.matured
    ? 'unknown'
    : signals.some((signal) => signal.dimension === 'hiringIntent')
      ? 'evergreen'
      : 'specific';

  return {
    freshness,
    hiringIntent,
    fraudRisk,
    provenance,
    signals,
    blocked: config.block_on_high_fraud_risk && fraudRisk === 'high',
  };
}
