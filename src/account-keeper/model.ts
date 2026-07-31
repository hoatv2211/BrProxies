import type {
  AccountStage,
  DraftState,
  InputSource,
  JobStatus,
  JobView,
  ManagedProfileView,
  ProgressLogEntry,
  ProgressEvent,
} from "./types";

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

export function activeInputSource(draft: DraftState): InputSource {
  switch (draft.inputMode) {
    case "inline":
      return { kind: "inline", text: draft.inputText };
    case "file":
      return { kind: "file", path: draft.inputPath };
    default: {
      const exhaustiveMode: never = draft.inputMode;
      return exhaustiveMode;
    }
  }
}

export function canStart(draft: DraftState, jobs: readonly JobView[]): boolean {
  const source = activeInputSource(draft);
  const hasActiveInput = source.kind === "inline"
    ? source.text.trim().length > 0
    : source.path.trim().length > 0;
  if (!hasActiveInput || !draft.outputPath.trim()) return false;
  if (!draft.plaintextAcknowledged) return false;
  if (!draft.templateValidation?.valid) return false;
  if (!draft.inputValidation || draft.inputValidation.validCount < 1) return false;
  if (draft.inputValidationRevision !== draft.inputRevision) return false;
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

export function isCleanableJob(job: JobView | null): boolean {
  return job !== null
    && !job.batchBlocked
    && ["completed", "failed", "cancelled", "abandoned"].includes(job.status);
}

export function progressLogEntries(job: JobView | null): ProgressLogEntry[] {
  if (!job) return [];
  return job.accounts
    .map((account) => ({
      key: `${account.account_key}:${account.updated_at}:${account.stage}`,
      updated_at: account.updated_at || job.updated_at,
      masked_account: account.masked_account,
      stage: account.stage,
      attempts: account.attempts,
      error_code: account.error_code,
    }))
    .sort((left, right) => left.updated_at.localeCompare(right.updated_at));
}

export function profileImportJson(profile: ManagedProfileView): string {
  return JSON.stringify(profile.import_payload, null, 2);
}
