import type { AccountStage, DraftState, JobStatus, JobView, ProgressEvent } from "./types";

const terminalJobStatuses = new Set<JobStatus>([
  "completed",
  "cancelled",
  "abandoned",
  "failed",
]);

const resumableAccountStages = new Set<AccountStage>([
  "queued",
  "launching",
  "logging_in",
  "submitting_totp",
  "changing_password",
  "verifying_new_password",
]);

export function canStart(draft: DraftState, jobs: readonly JobView[]): boolean {
  if (!draft.inputPath.trim() || !draft.outputPath.trim()) return false;
  if (!draft.plaintextAcknowledged) return false;
  if (!draft.templateValidation?.valid) return false;
  if (!draft.inputValidation || draft.inputValidation.validCount < 1) return false;
  return !jobs.some((job) => job.batchBlocked || !terminalJobStatuses.has(job.status));
}

export function canResume(job: JobView): boolean {
  if (job.batchBlocked || terminalJobStatuses.has(job.status)) return false;
  return job.accounts.some((account) => resumableAccountStages.has(account.stage));
}

export function reduceProgress(jobs: readonly JobView[], event: ProgressEvent): JobView[] {
  const jobIndex = jobs.findIndex((job) => job.batch_id === event.job.batch_id);
  if (jobIndex < 0) return jobs as JobView[];

  const current = jobs[jobIndex];
  if (event.revision <= current.revision) return jobs as JobView[];

  const critical = event.job.status === "critical"
    || event.job.accounts.some((account) => account.stage === "critical");
  const nextJob: JobView = {
    ...event.job,
    revision: event.revision,
    status: critical ? "critical" : event.job.status,
    batchBlocked: critical,
  };
  const nextJobs = [...jobs];
  nextJobs[jobIndex] = nextJob;
  return nextJobs;
}
