import type { Database } from '../database.js';
import { CompanyRepository } from './companies.js';
import { JobRepository } from './jobs.js';
import { SourcePostingRepository } from './source-postings.js';
import { SnapshotRepository } from './snapshots.js';
import { JobEventRepository } from './job-events.js';
import { ScanRepository } from './scans.js';

export interface Repositories {
  companies: CompanyRepository;
  jobs: JobRepository;
  postings: SourcePostingRepository;
  snapshots: SnapshotRepository;
  events: JobEventRepository;
  scans: ScanRepository;
}

export function createRepositories(db: Database): Repositories {
  return {
    companies: new CompanyRepository(db),
    jobs: new JobRepository(db),
    postings: new SourcePostingRepository(db),
    snapshots: new SnapshotRepository(db),
    events: new JobEventRepository(db),
    scans: new ScanRepository(db),
  };
}

export {
  CompanyRepository,
  JobRepository,
  SourcePostingRepository,
  SnapshotRepository,
  JobEventRepository,
  ScanRepository,
};
export type { JobRecord, JobListFilters, ScopeState } from './jobs.js';
export type { SourcePosting } from './source-postings.js';
export type { SourceRunResult } from './scans.js';
