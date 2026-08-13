import type { Database } from '../database.js';
import { CompanyRepository } from './companies.js';
import { JobRepository } from './jobs.js';
import { SnapshotRepository } from './snapshots.js';
import { JobEventRepository } from './job-events.js';
import { ScanRepository } from './scans.js';

export interface Repositories {
  companies: CompanyRepository;
  jobs: JobRepository;
  snapshots: SnapshotRepository;
  events: JobEventRepository;
  scans: ScanRepository;
}

export function createRepositories(db: Database): Repositories {
  return {
    companies: new CompanyRepository(db),
    jobs: new JobRepository(db),
    snapshots: new SnapshotRepository(db),
    events: new JobEventRepository(db),
    scans: new ScanRepository(db),
  };
}

export { CompanyRepository, JobRepository, SnapshotRepository, JobEventRepository, ScanRepository };
export type { JobWithCompany, JobListFilters } from './jobs.js';
export type { SourceRunResult } from './scans.js';
