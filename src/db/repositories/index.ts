import type { Database } from '../database.js';
import { CompanyRepository } from './companies.js';
import { JobRepository } from './jobs.js';
import { SourcePostingRepository } from './source-postings.js';
import { SnapshotRepository } from './snapshots.js';
import { JobEventRepository } from './job-events.js';
import { ScanRepository } from './scans.js';
import { ScreeningRepository, LlmCallRepository } from './screenings.js';
import { EvaluationRepository } from './evaluations.js';
import { FactRepository } from './facts.js';
import { ArchetypeAssignmentRepository, ArtifactRepository, ResumeRepository } from './resumes.js';
import { ApplicationRepository, NoteRepository } from './applications.js';
import { AnswerRepository } from './answers.js';

export interface Repositories {
  companies: CompanyRepository;
  jobs: JobRepository;
  postings: SourcePostingRepository;
  snapshots: SnapshotRepository;
  events: JobEventRepository;
  scans: ScanRepository;
  screenings: ScreeningRepository;
  llmCalls: LlmCallRepository;
  evaluations: EvaluationRepository;
  facts: FactRepository;
  assignments: ArchetypeAssignmentRepository;
  resumes: ResumeRepository;
  artifacts: ArtifactRepository;
  applications: ApplicationRepository;
  notes: NoteRepository;
  answers: AnswerRepository;
}

export function createRepositories(db: Database): Repositories {
  return {
    companies: new CompanyRepository(db),
    jobs: new JobRepository(db),
    postings: new SourcePostingRepository(db),
    snapshots: new SnapshotRepository(db),
    events: new JobEventRepository(db),
    scans: new ScanRepository(db),
    screenings: new ScreeningRepository(db),
    llmCalls: new LlmCallRepository(db),
    evaluations: new EvaluationRepository(db),
    facts: new FactRepository(db),
    assignments: new ArchetypeAssignmentRepository(db),
    resumes: new ResumeRepository(db),
    artifacts: new ArtifactRepository(db),
    applications: new ApplicationRepository(db),
    notes: new NoteRepository(db),
    answers: new AnswerRepository(db),
  };
}

export {
  CompanyRepository,
  JobRepository,
  SourcePostingRepository,
  SnapshotRepository,
  JobEventRepository,
  ScanRepository,
  ScreeningRepository,
  LlmCallRepository,
  EvaluationRepository,
  FactRepository,
  ArchetypeAssignmentRepository,
  ResumeRepository,
  ArtifactRepository,
  ApplicationRepository,
  NoteRepository,
  AnswerRepository,
};
export type { JobRecord, JobListFilters, ScopeState } from './jobs.js';
export type { SourcePosting } from './source-postings.js';
export type { SourceRunResult } from './scans.js';
export type { Screening, SpendSummary } from './screenings.js';
export type { EvaluationRecord } from './evaluations.js';
export type { Fact, FactImport, FactStatus, Experience } from './facts.js';
export type { ArchetypeAssignment, ResumeGeneration, ResumeClaim, ArtifactRecord } from './resumes.js';
export type { Application, StatusEvent, RoleFeedback, FeedbackKind } from './applications.js';
export type { StoredAnswer, AnswerLookup, AnswerProvenance, AnswerScope } from './answers.js';
