import { randomUUID } from 'node:crypto';
import type { Result } from '../src/lib/dataset';
import type { ExtractProgress } from './extract';

export type JobStatus = 'running' | 'done' | 'error';

export type ExtractJob = {
  id: string;
  status: JobStatus;
  progress: ExtractProgress;
  result?: Result;
  error?: string;
  createdAt: number;
};

const jobs = new Map<string, ExtractJob>();
const JOB_TTL_MS = 6 * 60 * 60 * 1000;

export function createJob(): ExtractJob {
  pruneJobs();
  const job: ExtractJob = {
    id: randomUUID(),
    status: 'running',
    progress: { phase: 'Starting cloud extraction…', completed: 0, total: 1 },
    createdAt: Date.now(),
  };
  jobs.set(job.id, job);
  return job;
}

export function getJob(id: string): ExtractJob | undefined {
  return jobs.get(id);
}

export function setJobProgress(job: ExtractJob, progress: ExtractProgress): void {
  job.progress = progress;
}

export function finishJob(job: ExtractJob, result: Result): void {
  job.status = 'done';
  job.result = result;
}

export function failJob(job: ExtractJob, error: string): void {
  job.status = 'error';
  job.error = error;
}

export const JOB_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function pruneJobs(): void {
  const cutoff = Date.now() - JOB_TTL_MS;
  for (const [id, job] of jobs) {
    if (job.createdAt < cutoff) jobs.delete(id);
  }
}
