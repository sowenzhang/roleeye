import type { IsoTimestamp } from '../util/time.js';

/** Where a posting came from. Adapters register under these names. */
export type SourceType = 'greenhouse' | 'lever' | 'ashby' | 'career-page';

export type WorkArrangement = 'remote' | 'hybrid' | 'onsite' | 'unknown';

export type EmploymentType = 'full-time' | 'part-time' | 'contract' | 'internship' | 'unknown';

export type SalaryPeriod = 'year' | 'month' | 'week' | 'day' | 'hour';

export interface Company {
  id: string;
  name: string;
  normalizedName: string;
  domain: string | undefined;
  careersUrl: string | undefined;
  notes: string | undefined;
  createdAt: IsoTimestamp;
}

/** A logical opportunity. Never deleted, only closed. */
export interface Job {
  id: string;
  companyId: string;
  title: string;
  normalizedTitle: string;
  level: string | undefined;
  employmentType: EmploymentType;
  workArrangement: WorkArrangement;
  locationText: string | undefined;
  country: string | undefined;
  salaryMin: number | undefined;
  salaryMax: number | undefined;
  salaryCurrency: string | undefined;
  salaryPeriod: SalaryPeriod | undefined;
  sourceType: SourceType;
  sourceJobId: string | undefined;
  sourceUrl: string;
  canonicalUrl: string | undefined;
  applyUrl: string | undefined;
  identityKey: string;
  descriptionText: string;
  descriptionHash: string;
  fingerprint: string;
  firstSeenAt: IsoTimestamp;
  lastSeenAt: IsoTimestamp;
  closedAt: IsoTimestamp | undefined;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

/** Immutable capture of a posting as it existed at a point in time. */
export interface JobSnapshot {
  id: string;
  jobId: string;
  capturedAt: IsoTimestamp;
  sourceUrl: string;
  rawPayload: string | undefined;
  normalizedDescription: string;
  descriptionHash: string;
}

export type JobEventType = 'discovered' | 'seen_again' | 'changed' | 'reposted' | 'closed';

export interface JobSeenEvent {
  id: string;
  jobId: string;
  seenAt: IsoTimestamp;
  sourceType: SourceType;
  sourceJobId: string | undefined;
  url: string;
  eventType: JobEventType;
  detail: string | undefined;
}

export type SourceRunStatus = 'running' | 'ok' | 'failed';

export interface SourceRun {
  id: string;
  scanId: string;
  sourceName: string;
  sourceType: SourceType;
  startedAt: IsoTimestamp;
  finishedAt: IsoTimestamp | undefined;
  status: SourceRunStatus;
  recordsSeen: number;
  recordsNew: number;
  recordsChanged: number;
  error: string | undefined;
}

export type EvaluationDecision = 'APPLY' | 'MAYBE' | 'SKIP';

export type ApplicationStatus =
  | 'DISCOVERED'
  | 'RECOMMENDED'
  | 'REVIEWING'
  | 'APPLIED'
  | 'RECRUITER_SCREEN'
  | 'INTERVIEWING'
  | 'FINAL'
  | 'OFFER'
  | 'SKIPPED'
  | 'REJECTED'
  | 'WITHDRAWN'
  | 'CLOSED'
  | 'NO_RESPONSE';

export type ArtifactType =
  | 'resume'
  | 'resume_diff'
  | 'cover_letter'
  | 'application_answers'
  | 'interview_notes'
  | 'recruiter_message'
  | 'analysis';

export interface RawSalary {
  min?: number | undefined;
  max?: number | undefined;
  currency?: string | undefined;
  period?: SalaryPeriod | undefined;
  text?: string | undefined;
}

/**
 * Raw-ish adapter output. Adapters never score and never write to the database;
 * they hand this to the ingestion pipeline.
 */
export interface DiscoveredJob {
  sourceType: SourceType;
  sourceName: string;
  sourceJobId?: string | undefined;
  companyName: string;
  title: string;
  location?: string | undefined;
  url: string;
  applyUrl?: string | undefined;
  description?: string | undefined;
  descriptionHtml?: string | undefined;
  employmentType?: EmploymentType | undefined;
  salary?: RawSalary | undefined;
  postedAt?: IsoTimestamp | undefined;
  rawPayload?: unknown;
}
