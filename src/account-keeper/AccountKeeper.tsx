import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open, save as saveDialog } from "@tauri-apps/plugin-dialog";
import {
  activeInputSource,
  canResume,
  canStart,
  isCleanableJob,
  progressLogEntries,
  reduceProgress,
} from "./model";
import type {
  AccountKeeperDefaultsDto,
  AccountStage,
  AccountView,
  DraftState,
  InputSource,
  InputValidationDto,
  JobStatus,
  JobView,
  ManagedProfileView,
  ProgressEvent,
  TemplateValidationDto,
} from "./types";
import "./AccountKeeper.css";

type ConfirmOptions = {
  title?: string;
  message: string;
  buttons?: { label: string; value: any; danger?: boolean; primary?: boolean }[];
  danger?: boolean;
};

type AccountKeeperProps = {
  confirm: (options: ConfirmOptions) => Promise<any>;
};

const accountStages = new Set<AccountStage>([
  "queued", "launching", "logging_in", "submitting_totp", "changing_password",
  "verifying_new_password", "changing_totp", "verifying_new_totp", "changing_email",
  "waiting_email_verification", "verifying_new_email", "waiting_manual", "success",
  "failed", "critical", "cancelled",
]);

const jobStatuses = new Set<JobStatus>([
  "queued", "running", "paused", "waiting_manual", "completed", "failed",
  "critical", "cancelled", "abandoned",
]);

const terminalJobStatuses = new Set<JobStatus>(["completed", "cancelled", "abandoned", "failed"]);

const initialDraft: DraftState = {
  operation: "change_password",
  inputMode: "inline",
  inputText: "",
  inputPath: "",
  inputRevision: 0,
  inputValidationRevision: null,
  outputPath: "",
  templateText: "",
  keepProfileRunning: false,
  plaintextAcknowledged: false,
  inputValidation: null,
  templateValidation: null,
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : null;
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asNullableString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function asBoolean(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function asStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function errorMessage(value: unknown): string {
  if (typeof value === "string") return value;
  const message = asString(asRecord(value)?.message).trim();
  if (message) return message;
  try {
    const serialized = JSON.stringify(value);
    if (serialized && serialized !== "{}") return serialized;
  } catch {
    return "Unknown error";
  }
  return "Unknown error";
}

function normalizeDefaults(value: unknown): AccountKeeperDefaultsDto {
  const record = asRecord(value);
  const template = asString(record?.template).trim();
  const outputPath = asString(record?.outputPath ?? record?.output_path).trim();
  if (!template || !outputPath) {
    throw new Error("Invalid Account Keeper defaults");
  }
  return { template, outputPath };
}

function normalizeAccount(value: unknown): AccountView | null {
  const record = asRecord(value);
  if (!record) return null;
  const accountKey = asString(record.account_key);
  const stage = asString(record.stage) as AccountStage;
  if (!accountKey || !accountStages.has(stage)) return null;
  return {
    account_key: accountKey,
    masked_account: asString(record.masked_account, "Masked account"),
    profile_id: asNullableString(record.profile_id),
    stage,
    attempts: asNumber(record.attempts),
    updated_at: asString(record.updated_at),
    error_code: asNullableString(record.error_code ?? record.error),
  };
}

function normalizeJobStatus(value: unknown): JobStatus {
  const status = asString(value);
  if (jobStatuses.has(status as JobStatus)) return status as JobStatus;
  return "queued";
}

function normalizeJob(value: unknown, revision = 0): JobView | null {
  const record = asRecord(value);
  if (!record) return null;
  const batchId = asString(record.batch_id);
  if (!batchId) return null;
  const accounts = Array.isArray(record.accounts)
    ? record.accounts.map(normalizeAccount).filter((account): account is AccountView => account !== null)
    : [];
  const status = normalizeJobStatus(record.status);
  const critical = accounts.some((account) => account.stage === "critical");
  return {
    batch_id: batchId,
    status: critical ? "critical" : status,
    updated_at: asString(record.updated_at),
    output_path: asString(record.output_path),
    keep_profile_running: asBoolean(record.keep_profile_running),
    pause_after_current: asBoolean(record.pause_after_current),
    accounts,
    revision,
    batchBlocked: critical || status === "critical",
  };
}

function normalizeInputValidation(value: unknown): InputValidationDto {
  const record = asRecord(value) ?? {};
  return {
    validCount: asNumber(record.validCount ?? record.valid_count),
    maskedAccounts: asStrings(record.maskedAccounts ?? record.masked_accounts),
  };
}

function normalizeTemplateValidation(value: unknown): TemplateValidationDto {
  const record = asRecord(value) ?? {};
  return {
    valid: asBoolean(record.valid),
    finalLength: asNumber(record.finalLength ?? record.final_length),
    hasUppercase: asBoolean(record.hasUppercase ?? record.has_uppercase),
    hasLowercase: asBoolean(record.hasLowercase ?? record.has_lowercase),
    hasDigit: asBoolean(record.hasDigit ?? record.has_digit),
    hasSymbol: asBoolean(record.hasSymbol ?? record.has_symbol),
  };
}

function normalizeProgress(value: unknown): ProgressEvent | null {
  const record = asRecord(value);
  if (!record) return null;
  const revision = asNumber(record.revision, -1);
  const job = normalizeJob(record.job, revision);
  return revision < 0 || !job ? null : { revision, job };
}

function normalizeManagedProfile(value: unknown): ManagedProfileView | null {
  const record = asRecord(value);
  const profileId = asString(record?.profile_id);
  const maskedAccount = asString(record?.masked_account);
  if (
    !profileId
    || !maskedAccount
    || asString(record?.status) !== "success"
  ) {
    return null;
  }
  return {
    profile_id: profileId,
    masked_account: maskedAccount,
    status: "success",
    last_verified_at: asNullableString(record?.last_verified_at),
    running: asBoolean(record?.running),
    rotated: asBoolean(record?.rotated),
    codex_auth: (() => {
      const auth = asRecord(record?.codex_auth);
      const status = asString(auth?.status);
      return {
        status: status === "ready" || status === "reconnect_required" ? status : "missing",
        expires_at: asNullableString(auth?.expires_at),
        has_account_id: asBoolean(auth?.has_account_id),
      };
    })(),
  };
}

function upsertJob(jobs: readonly JobView[], job: JobView): JobView[] {
  const index = jobs.findIndex((item) => item.batch_id === job.batch_id);
  if (index < 0) return [job, ...jobs];
  const next = [...jobs];
  next[index] = job;
  return next;
}

function shortJobId(jobId: string): string {
  return jobId.length > 12 ? `${jobId.slice(0, 8)}…` : jobId;
}

function completedCount(job: JobView): number {
  return job.accounts.filter((account) => ["success", "failed", "critical", "cancelled"].includes(account.stage)).length;
}

function labelFor(value: string): string {
  return value.replace(/_/g, " ").replace(/\b\w/g, (letter: string) => letter.toUpperCase());
}

export function AccountKeeper({ confirm }: AccountKeeperProps) {
  const [draft, setDraft] = useState<DraftState>(initialDraft);
  const [jobs, setJobs] = useState<JobView[]>([]);
  const [profiles, setProfiles] = useState<ManagedProfileView[]>([]);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [showLogs, setShowLogs] = useState(false);
  const [importProfileId, setImportProfileId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const qaAdapterId = useRef("openai-chatgpt-v1");

  const refreshProfiles = async () => {
    const value = await invoke<unknown>("account_keeper_list_profiles");
    const record = asRecord(value);
    const entries = Array.isArray(value)
      ? value
      : Array.isArray(record?.profiles)
        ? record.profiles
        : [];
    setProfiles(entries
      .map(normalizeManagedProfile)
      .filter((profile): profile is ManagedProfileView => profile !== null));
  };

  useEffect(() => {
    if (!import.meta.env.DEV || new URLSearchParams(window.location.search).get("account-keeper-qa") !== "1") {
      return;
    }
    const root = document.documentElement;
    const configure = async () => {
      try {
        const serializedConfig = root.dataset.accountKeeperQaConfig ?? "null";
        delete root.dataset.accountKeeperQaConfig;
        const config = JSON.parse(serializedConfig) as {
          source?: unknown;
          outputPath?: unknown;
          templateText?: unknown;
          adapterId?: unknown;
        } | null;
        const sourceRecord = asRecord(config?.source);
        const sourceKeys = sourceRecord ? Object.keys(sourceRecord) : [];
        const source: InputSource | null = sourceRecord?.kind === "inline"
          && sourceKeys.length === 2
          && sourceKeys.includes("kind")
          && sourceKeys.includes("text")
          && typeof sourceRecord.text === "string"
          ? { kind: "inline", text: sourceRecord.text }
          : sourceRecord?.kind === "file"
            && sourceKeys.length === 2
            && sourceKeys.includes("kind")
            && sourceKeys.includes("path")
            && typeof sourceRecord.path === "string"
            ? { kind: "file", path: sourceRecord.path }
            : null;
        if (
          !config
          || !source
          || typeof config.outputPath !== "string"
          || typeof config.templateText !== "string"
        ) {
          throw new Error("invalid synthetic QA configuration");
        }
        const [inputValidation, templateValidation] = await Promise.all([
          invoke<unknown>("account_keeper_validate_input", {
            request: { source },
          }),
          invoke<unknown>("account_keeper_validate_template", {
            request: { template: config.templateText },
          }),
        ]);
        qaAdapterId.current = config.adapterId === "fixture-v1"
          ? "fixture-v1"
          : "openai-chatgpt-v1";
        setDraft((current) => {
          const inputRevision = current.inputRevision + 1;
          return {
            ...current,
            inputMode: source.kind,
            inputText: source.kind === "inline" ? source.text : current.inputText,
            inputPath: source.kind === "file" ? source.path : current.inputPath,
            inputRevision,
            inputValidationRevision: inputRevision,
            outputPath: config.outputPath as string,
            templateText: config.templateText as string,
            inputValidation: normalizeInputValidation(inputValidation),
            templateValidation: normalizeTemplateValidation(templateValidation),
            plaintextAcknowledged: false,
          };
        });
        root.dataset.accountKeeperQaStatus = "ready";
      } catch {
        root.dataset.accountKeeperQaStatus = "error:invalid_config";
      }
    };
    const onConfigure = () => void configure();
    root.addEventListener("account-keeper:qa-configure", onConfigure);
    root.dataset.accountKeeperQaStatus = "idle";
    return () => {
      root.removeEventListener("account-keeper:qa-configure", onConfigure);
      delete root.dataset.accountKeeperQaStatus;
    };
  }, []);

  useEffect(() => {
    let disposed = false;
    const loadDefaults = async () => {
      try {
        const defaults = normalizeDefaults(
          await invoke<unknown>("account_keeper_defaults"),
        );
        if (disposed) return;
        const validation = normalizeTemplateValidation(
          await invoke<unknown>("account_keeper_validate_template", {
            request: { template: defaults.template },
          }),
        );
        if (disposed) return;
        setDraft((current) => {
          const applyTemplate = current.templateText.trim() === "";
          return {
            ...current,
            templateText: applyTemplate ? defaults.template : current.templateText,
            templateValidation: applyTemplate ? validation : current.templateValidation,
            outputPath: current.outputPath.trim() === ""
              ? defaults.outputPath
              : current.outputPath,
          };
        });
      } catch (defaultsError) {
        if (!disposed) {
          setError(
            `Account Keeper defaults could not load: ${errorMessage(defaultsError)}`,
          );
        }
      }
    };
    void loadDefaults();
    return () => {
      disposed = true;
    };
  }, []);

  useEffect(() => {
    let disposed = false;
    let stopListening: (() => void) | undefined;
    let hydrated = false;
    const pending: ProgressEvent[] = [];

    const load = async () => {
      try {
        stopListening = await listen<unknown>("account-keeper:progress", ({ payload }) => {
          const progress = normalizeProgress(payload);
          if (!progress || disposed) return;
          if (!hydrated) pending.push(progress);
          else {
            setJobs((current) => current.some((job) => job.batch_id === progress.job.batch_id)
              ? reduceProgress(current, progress)
              : upsertJob(current, progress.job));
            if (progress.job.accounts.some((account) => account.stage === "success")) {
              void refreshProfiles().catch(() => {});
            }
          }
        });
        if (disposed) {
          stopListening();
          return;
        }

        const listResult = await invoke<unknown>("account_keeper_list_jobs");
        const listRecord = asRecord(listResult);
        const entries = Array.isArray(listResult)
          ? listResult
          : Array.isArray(listRecord?.jobs)
            ? listRecord.jobs
            : [];
        const summaries = entries.map(normalizeJob).filter((job): job is JobView => job !== null);
        const identifiers = entries
          .map((entry) => typeof entry === "string" ? entry : normalizeJob(entry)?.batch_id)
          .filter((jobId): jobId is string => Boolean(jobId));
        const detailed = await Promise.all(identifiers.map(async (jobId) => {
          try {
            return normalizeJob(await invoke<unknown>("account_keeper_get_job", {
              request: { batchId: jobId },
            }));
          } catch {
            return summaries.find((job) => job.batch_id === jobId) ?? null;
          }
        }));

        let nextJobs = detailed.filter((job): job is JobView => job !== null);
        for (const summary of summaries) nextJobs = upsertJob(nextJobs, summary);
        for (const progress of pending) {
          nextJobs = nextJobs.some((job) => job.batch_id === progress.job.batch_id)
            ? reduceProgress(nextJobs, progress)
            : upsertJob(nextJobs, progress.job);
        }
        hydrated = true;
        if (disposed) return;
        setJobs(nextJobs);
        setSelectedJobId((current) => current ?? nextJobs[0]?.batch_id ?? null);
        await refreshProfiles();
      } catch (loadError) {
        if (!disposed) setError(`Account Keeper could not load: ${String(loadError)}`);
      } finally {
        if (!disposed) setLoading(false);
      }
    };

    void load();
    return () => {
      disposed = true;
      stopListening?.();
    };
  }, []);

  const selectedJob = useMemo(() => {
    const selected = jobs.find((job) => job.batch_id === selectedJobId);
    if (selected) return selected;
    return jobs.find((job) => !terminalJobStatuses.has(job.status)) ?? jobs[0] ?? null;
  }, [jobs, selectedJobId]);

  const blockingJob = jobs.find((job) => job.batchBlocked) ?? null;
  const activeAccount = selectedJob?.accounts.find(
    (account) => account.stage === "waiting_manual" || account.stage === "critical",
  ) ?? selectedJob?.accounts.find(
    (account) => !["success", "failed", "critical", "cancelled"].includes(account.stage),
  ) ?? null;
  const startEnabled = canStart(draft, jobs) && busyAction === null;
  const activeJob = selectedJob && !terminalJobStatuses.has(selectedJob.status) ? selectedJob : null;
  const resumableJobs = jobs.filter((job) => !terminalJobStatuses.has(job.status));
  const selectedLogs = useMemo(() => progressLogEntries(selectedJob), [selectedJob]);
  const importProfile = profiles.find((profile) => profile.profile_id === importProfileId) ?? null;
  const readyCodexProfileIds = useMemo(
    () => profiles.filter((profile) => profile.codex_auth.status === "ready").map((profile) => profile.profile_id),
    [profiles],
  );

  const replaceJob = (value: unknown) => {
    const job = normalizeJob(value);
    if (!job) return false;
    setJobs((current) => {
      const existing = current.find((item) => item.batch_id === job.batch_id);
      return upsertJob(current, {
        ...job,
        revision: existing?.revision ?? job.revision,
      });
    });
    setSelectedJobId(job.batch_id);
    return true;
  };

  const refreshJob = async (jobId: string) => {
    const result = await invoke<unknown>("account_keeper_get_job", {
      request: { batchId: jobId },
    });
    replaceJob(result);
  };

  const runAction = async (
    key: string,
    command: string,
    args: Record<string, unknown>,
    success: string,
    jobId?: string,
  ) => {
    setBusyAction(key);
    setError(null);
    setNotice(null);
    try {
      const result = await invoke<unknown>(command, args);
      if (!replaceJob(result) && jobId) await refreshJob(jobId);
      setNotice(success);
      return true;
    } catch (actionError) {
      setError(String(actionError));
      return false;
    } finally {
      setBusyAction(null);
    }
  };

  const chooseInput = async () => {
    const path = await open({
      multiple: false,
      directory: false,
      title: "Select Account Keeper input",
      filters: [{ name: "Text", extensions: ["txt"] }],
    });
    if (typeof path !== "string") return;
    const requestRevision = draft.inputRevision + 1;
    setBusyAction("validate-input");
    setError(null);
    setDraft((current) => ({
      ...current,
      inputMode: "file",
      inputPath: path,
      inputRevision: requestRevision,
      inputValidation: null,
      inputValidationRevision: null,
    }));
    try {
      const validation = normalizeInputValidation(
        await invoke<unknown>("account_keeper_validate_input", {
          request: {
            source: { kind: "file", path },
            ...(draft.operation === "change_password" ? {} : { operation: draft.operation }),
          },
        }),
      );
      setDraft((current) => current.inputMode === "file"
        && current.inputPath === path
        && current.inputRevision === requestRevision
        ? {
          ...current,
          inputValidation: validation,
          inputValidationRevision: requestRevision,
        }
        : current);
    } catch (validationError) {
      setError(String(validationError));
    } finally {
      setBusyAction(null);
    }
  };

  const validateInput = async () => {
    const source = activeInputSource(draft);
    const inputRevision = draft.inputRevision;
    setBusyAction("validate-input");
    setError(null);
    try {
      const validation = normalizeInputValidation(
        await invoke<unknown>("account_keeper_validate_input", {
          request: {
            source,
            ...(draft.operation === "change_password" ? {} : { operation: draft.operation }),
          },
        }),
      );
      setDraft((current) => current.inputRevision === inputRevision
        ? {
          ...current,
          inputValidation: validation,
          inputValidationRevision: inputRevision,
        }
        : current);
    } catch (validationError) {
      setError(String(validationError));
    } finally {
      setBusyAction(null);
    }
  };

  const chooseOutput = async () => {
    const path = await saveDialog({
      title: "Select Account Keeper output",
      defaultPath: "account-keeper-result.json",
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    if (typeof path !== "string") return;
    setDraft((current) => ({ ...current, outputPath: path }));
  };

  const validateTemplate = async () => {
    setBusyAction("validate-template");
    setError(null);
    const template = draft.templateText;
    try {
      const validation = normalizeTemplateValidation(
        await invoke<unknown>("account_keeper_validate_template", {
          request: { template },
        }),
      );
      setDraft((current) => current.templateText === template
        ? { ...current, templateValidation: validation }
        : current);
    } catch (validationError) {
      setError(String(validationError));
    } finally {
      setBusyAction(null);
    }
  };

  const startBatch = async () => {
    if (!canStart(draft, jobs)) return;
    const approved = await confirm({
      title: "Start Account Keeper batch",
      message: draft.inputMode === "inline"
        ? "The pasted input and output file contain plaintext secrets. Start this batch now?"
        : "The selected input and output files contain plaintext secrets. Start this batch now?",
      buttons: [
        { label: "Cancel", value: false },
        { label: "Start Batch", value: true, primary: true },
      ],
    });
    if (approved !== true) return;
    const started = await runAction(
      "start",
      "account_keeper_start_batch",
      {
        request: {
          source: activeInputSource(draft),
          outputPath: draft.operation === "login" ? "" : draft.outputPath,
          template: draft.operation === "change_password" ? draft.templateText : "",
          adapterId: qaAdapterId.current,
          operation: draft.operation,
          keepProfileRunning: draft.keepProfileRunning,
          pauseAfterCurrent: false,
        },
      },
      "Batch started.",
    );
    if (started) {
      setDraft((current) => {
        const inlineActive = current.inputMode === "inline";
        return {
          ...current,
          inputText: "",
          inputRevision: inlineActive ? current.inputRevision + 1 : current.inputRevision,
          inputValidation: inlineActive ? null : current.inputValidation,
          inputValidationRevision: inlineActive ? null : current.inputValidationRevision,
          plaintextAcknowledged: false,
        };
      });
    }
  };

  const pauseAfterCurrent = async () => {
    if (!activeJob) return;
    await runAction(
      "pause",
      "account_keeper_pause_after_current",
      { request: { batchId: activeJob.batch_id } },
      "The batch will pause after the current account.",
      activeJob.batch_id,
    );
  };

  const cancelBatch = async () => {
    if (!activeJob) return;
    const approved = await confirm({
      title: "Cancel Account Keeper batch",
      message: "Cancel this batch? Credential-state uncertainty may require manual recovery.",
      danger: true,
      buttons: [
        { label: "Keep Running", value: false },
        { label: "Cancel Batch", value: true, danger: true },
      ],
    });
    if (approved !== true) return;
    await runAction(
      "cancel",
      "account_keeper_cancel_batch",
      { request: { batchId: activeJob.batch_id } },
      "Batch cancellation requested.",
      activeJob.batch_id,
    );
  };

  const continueManual = async () => {
    if (!selectedJob || !activeAccount) return;
    await runAction(
      "continue",
      "account_keeper_continue_manual",
      { request: { batchId: selectedJob.batch_id, accountKey: activeAccount.account_key } },
      "Manual flow continued.",
      selectedJob.batch_id,
    );
  };

  const markFailed = async () => {
    if (!selectedJob || !activeAccount) return;
    const approved = await confirm({
      title: "Mark account failed",
      message: `Mark ${activeAccount.masked_account} failed and continue when safe?`,
      danger: true,
    });
    if (approved !== true) return;
    await runAction(
      "mark-failed",
      "account_keeper_mark_failed",
      { request: { batchId: selectedJob.batch_id, accountKey: activeAccount.account_key } },
      "Account marked failed.",
      selectedJob.batch_id,
    );
  };

  const openProfile = async (account: AccountView | null) => {
    if (!account?.profile_id) return;
    await runAction(
      `open-${account.account_key}`,
      "account_keeper_open_profile",
      { request: { profileId: account.profile_id } },
      "Profile opened.",
    );
  };

  const resumeJob = async (job: JobView) => {
    await runAction(
      `resume-${job.batch_id}`,
      "account_keeper_resume_job",
      { request: { batchId: job.batch_id } },
      "Job resumed.",
      job.batch_id,
    );
  };

  const resolveCritical = async (job: JobView, account: AccountView | null) => {
    if (!account) return;
    const approved = await confirm({
      title: "Verify & resolve critical account",
      message:
        `Re-verify the attempted password for ${account.masked_account} against the live login? ` +
        "If it signs in, the new password is accepted and the profile is labeled.",
      buttons: [
        { label: "Cancel", value: false },
        { label: "Verify & Resolve", value: true, primary: true },
      ],
    });
    if (approved !== true) return;
    await runAction(
      `resolve-${account.account_key}`,
      "account_keeper_resolve_critical",
      { request: { batchId: job.batch_id, accountKey: account.account_key } },
      "Critical account resolved. New password accepted.",
      job.batch_id,
    );
  };

  const abandonJob = async (job: JobView) => {
    const approved = await confirm({
      title: "Abandon resumable job",
      message: `Abandon job ${shortJobId(job.batch_id)}? Profile mappings remain available.`,
      danger: true,
    });
    if (approved !== true) return;
    setBusyAction(`abandon-${job.batch_id}`);
    setError(null);
    setNotice(null);
    try {
      await invoke("account_keeper_abandon_job", {
        request: { batchId: job.batch_id },
      });
      setJobs((current) => current.filter((item) => item.batch_id !== job.batch_id));
      setSelectedJobId((current) => current === job.batch_id ? null : current);
      setNotice("Job abandoned.");
    } catch (actionError) {
      setError(String(actionError));
    } finally {
      setBusyAction(null);
    }
  };

  const exportResult = async (job: JobView) => {
    const approved = await confirm({
      title: "Export plaintext result",
      message: "Re-export this job's plaintext result to its selected local output path?",
      buttons: [
        { label: "Cancel", value: false },
        { label: "Export Result", value: true, primary: true },
      ],
    });
    if (approved !== true) return;
    await runAction(
      `export-${job.batch_id}`,
      "account_keeper_export_result",
      { request: { batchId: job.batch_id, outputPath: null } },
      "Result exported.",
      job.batch_id,
    );
  };

  const cleanProgress = async () => {
    if (!selectedJob || !isCleanableJob(selectedJob)) return;
    const approved = await confirm({
      title: "Clean progress",
      message: `Remove terminal progress for job ${shortJobId(selectedJob.batch_id)}? Matching unknown recovery state will also be forgotten so the account can be imported again. Verified profiles and browser profile data are preserved.`,
      buttons: [
        { label: "Cancel", value: false },
        { label: "Clean", value: true, danger: true },
      ],
    });
    if (approved !== true) return;
    setBusyAction(`clean-${selectedJob.batch_id}`);
    setError(null);
    setNotice(null);
    try {
      const result = await invoke<{ forgottenRecoveryAccounts: number }>("account_keeper_clean_progress", {
        request: { batchId: selectedJob.batch_id },
      });
      setJobs((current) => current.filter((job) => job.batch_id !== selectedJob.batch_id));
      setSelectedJobId((current) => current === selectedJob.batch_id ? null : current);
      setShowLogs(false);
      setNotice(result.forgottenRecoveryAccounts > 0
        ? "Progress cleaned. Unknown recovery state forgotten; browser profile was preserved."
        : "Progress cleaned. Verified profiles were preserved.");
    } catch (actionError) {
      setError(String(actionError));
    } finally {
      setBusyAction(null);
    }
  };

  const openManagedProfile = async (profile: ManagedProfileView) => {
    setBusyAction(`run-profile-${profile.profile_id}`);
    setError(null);
    setNotice(null);
    try {
      await invoke("account_keeper_open_profile", {
        request: { profileId: profile.profile_id },
      });
      await refreshProfiles();
      setNotice("Profile opened.");
    } catch (actionError) {
      setError(String(actionError));
    } finally {
      setBusyAction(null);
    }
  };

  const deleteManagedProfile = async (profile: ManagedProfileView) => {
    const approved = await confirm({
      title: "Delete managed profile",
      message: `Delete the browser profile for ${profile.masked_account}? This removes its local browser data and Account Keeper vault mapping.`,
      danger: true,
      buttons: [
        { label: "Cancel", value: false },
        { label: "Delete Profile", value: true, danger: true },
      ],
    });
    if (approved !== true) return;
    setBusyAction(`delete-profile-${profile.profile_id}`);
    setError(null);
    setNotice(null);
    try {
      await invoke("account_keeper_delete_profile", {
        request: { profileId: profile.profile_id },
      });
      setProfiles((current) => current.filter((item) => item.profile_id !== profile.profile_id));
      setImportProfileId((current) => current === profile.profile_id ? null : current);
      setNotice("Managed profile deleted.");
    } catch (actionError) {
      setError(String(actionError));
    } finally {
      setBusyAction(null);
    }
  };

  const connectCodex = async (profile: ManagedProfileView) => {
    setBusyAction(`connect-codex-${profile.profile_id}`);
    setError(null);
    setNotice(null);
    try {
      const codexAuth = await invoke<NonNullable<ManagedProfileView["codex_auth"]>>(
        "account_keeper_connect_codex",
        { request: { profileId: profile.profile_id } },
      );
      setProfiles((current) => current.map((item) => item.profile_id === profile.profile_id
        ? { ...item, codex_auth: codexAuth }
        : item));
      setImportProfileId(profile.profile_id);
      setNotice("Codex OAuth connected. Export JSON is ready.");
    } catch (actionError) {
      setError(String(actionError));
    } finally {
      setBusyAction(null);
    }
  };

  const exportCodex = async (
    profileIds: string[],
    format: "nine_router" | "cockpit",
    destination: "copy" | "save",
  ) => {
    const approved = await confirm({
      title: "Export plaintext Codex credentials",
      message: `${destination === "copy" ? "Copy" : "Save"} ${profileIds.length} Codex account credential${profileIds.length === 1 ? "" : "s"} for ${format === "nine_router" ? "9Router" : "Cockpit"}? The JSON contains plaintext OAuth tokens.`,
      buttons: [
        { label: "Cancel", value: false },
        { label: destination === "copy" ? "Copy JSON" : "Save JSON", value: true, primary: true },
      ],
    });
    if (approved !== true) return;
    const action = `${destination}-${format}-${profileIds.join("-")}`;
    setBusyAction(action);
    setError(null);
    setNotice(null);
    try {
      if (destination === "copy") {
        const result = await invoke<{ exportedCount: number }>("account_keeper_copy_codex_export", {
          request: { profileIds, format },
        });
        setNotice(`${result.exportedCount} Codex account(s) copied for ${format === "nine_router" ? "9Router" : "Cockpit"}.`);
      } else {
        const outputPath = await saveDialog({
          title: `Save ${format === "nine_router" ? "9Router" : "Cockpit"} Codex JSON`,
          defaultPath: format === "nine_router" ? "9router-codex-accounts.json" : "cockpit-codex-accounts.json",
          filters: [{ name: "JSON", extensions: ["json"] }],
        });
        if (!outputPath) return;
        const result = await invoke<{ exportedCount: number }>("account_keeper_save_codex_export", {
          request: { profileIds, format, outputPath },
        });
        setNotice(`${result.exportedCount} Codex account(s) saved.`);
      }
    } catch (actionError) {
      setError(String(actionError));
    } finally {
      setBusyAction(null);
    }
  };

  return (
    <section className="account-keeper page" aria-labelledby="account-keeper-title">
      <div className="account-keeper__header">
        <div>
          <p className="account-keeper__eyebrow">GPT ACCOUNT MANAGEMENT</p>
          <h1 id="account-keeper-title">Account Keeper</h1>
          <p className="account-keeper__subtitle">
            Manage and update GPT accounts in one place — log in, change passwords, rotate 2FA, and update account emails with isolated browser profiles.
          </p>
        </div>
        <div className="account-keeper__header-status" aria-live="polite">
          {loading ? "Loading jobs…" : `${resumableJobs.length} resumable job${resumableJobs.length === 1 ? "" : "s"}`}
        </div>
      </div>

      {blockingJob && (
        <div className="account-keeper__critical" role="alert">
          <div>
            <strong>Critical recovery required</strong>
            <p>
              Job {shortJobId(blockingJob.batch_id)} is blocked. Verify the affected account manually before processing can continue.
            </p>
          </div>
          <div className="account-keeper__critical-actions">
            <button
              type="button"
              className="btn-ghost danger"
              onClick={() => void openProfile(
                blockingJob.accounts.find((account) => account.stage === "critical") ?? null,
              )}
              disabled={!blockingJob.accounts.some((account) => account.stage === "critical" && account.profile_id)}
            >
              Open Profile
            </button>
            <button
              type="button"
              className="btn-primary"
              onClick={() => void resolveCritical(
                blockingJob,
                blockingJob.accounts.find((account) => account.stage === "critical") ?? null,
              )}
              disabled={busyAction !== null || !blockingJob.accounts.some((account) => account.stage === "critical" && account.profile_id)}
            >
              Verify &amp; Resolve
            </button>
          </div>
        </div>
      )}

      {error && <div className="account-keeper__message account-keeper__message--error" role="alert">{error}</div>}
      {notice && <div className="account-keeper__message" role="status">{notice}</div>}

      <div className="account-keeper__workspace">
        <section className="account-keeper__panel account-keeper__setup" aria-labelledby="account-keeper-setup-title">
          <div className="account-keeper__panel-head">
            <div>
              <span className="account-keeper__step">01</span>
              <h2 id="account-keeper-setup-title">Batch setup</h2>
            </div>
            <span className="account-keeper__panel-note">Files stay local</span>
          </div>

          <div className="account-keeper__field">
            <span className="account-keeper__field-label">Operation</span>
            <div className="account-keeper__source-modes" role="group" aria-label="Operation">
              {([
                ["change_password", "Change pass"],
                ["login", "Login GPT"],
                ["change_totp", "Change 2FA"],
                ["change_email", "Change email"],
              ] as const).map(([mode, label]) => (
                <button
                  key={mode}
                  type="button"
                  aria-pressed={draft.operation === mode}
                  onClick={() => setDraft((current) => current.operation === mode
                    ? current
                    : {
                      ...current,
                      operation: mode,
                      inputRevision: current.inputRevision + 1,
                      inputValidation: null,
                      inputValidationRevision: null,
                      plaintextAcknowledged: false,
                    })}
                  disabled={busyAction !== null}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          <div className="account-keeper__field">
            <span className="account-keeper__field-label">Input source</span>
            <div className="account-keeper__source-modes" role="group" aria-label="Input source">
              {(["inline", "file"] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  aria-pressed={draft.inputMode === mode}
                  onClick={() => setDraft((current) => current.inputMode === mode
                    ? current
                    : {
                      ...current,
                      inputMode: mode,
                      inputRevision: current.inputRevision + 1,
                      inputValidation: null,
                      inputValidationRevision: null,
                      plaintextAcknowledged: false,
                    })}
                  disabled={busyAction !== null}
                >
                  {mode === "inline" ? "Paste text" : "Choose file"}
                </button>
              ))}
            </div>

            {draft.inputMode === "inline" ? (
              <>
                <label htmlFor="account-keeper-input-text">Account input</label>
                <textarea
                  id="account-keeper-input-text"
                  value={draft.inputText}
                  placeholder="owner@example.test|current-password|JBSWY3DPEHPK3PXP"
                  autoComplete="off"
                  spellCheck={false}
                  aria-describedby={draft.inputValidation
                    ? "account-keeper-input-help account-keeper-input-validation"
                    : "account-keeper-input-help"}
                  disabled={busyAction !== null}
                  onChange={(event) => setDraft((current) => ({
                    ...current,
                    inputText: event.target.value,
                    inputRevision: current.inputRevision + 1,
                    inputValidation: null,
                    inputValidationRevision: null,
                  }))}
                />
                <small id="account-keeper-input-help">
                  {draft.operation === "change_email"
                    ? "current_email|current_password|totp_secret|new_email"
                    : "One account per line: account|current_password|totp_secret"}
                </small>
                <div className="account-keeper__input-actions">
                  <button
                    type="button"
                    className="btn-ghost"
                    onClick={() => void validateInput()}
                    disabled={!draft.inputText.trim() || busyAction !== null}
                  >
                    Validate Input
                  </button>
                </div>
              </>
            ) : (
              <>
                <label htmlFor="account-keeper-input-file">Input file</label>
                <div className="account-keeper__picker">
                  <input
                    id="account-keeper-input-file"
                    value={draft.inputPath}
                    placeholder="Choose a local text file"
                    aria-describedby={draft.inputValidation ? "account-keeper-input-validation" : undefined}
                    readOnly
                  />
                  <button
                    type="button"
                    className="btn-ghost"
                    aria-label="Choose input file"
                    onClick={() => void chooseInput()}
                    disabled={busyAction !== null}
                  >
                    Browse
                  </button>
                </div>
              </>
            )}
            {draft.inputValidation && (
              <div
                id="account-keeper-input-validation"
                role="status"
                aria-live="polite"
                className={`account-keeper__validation ${draft.inputValidation.validCount > 0 ? "is-valid" : "is-invalid"}`}
              >
                <strong>{draft.inputValidation.validCount > 0 ? "Input valid" : "Input needs attention"}</strong>
                <span>{draft.inputValidation.validCount} accounts</span>
                <span>{draft.inputValidation.maskedAccounts.slice(0, 3).join(", ")}</span>
              </div>
            )}
          </div>

          {draft.operation === "change_password" && (
          <div className="account-keeper__field">
            <label htmlFor="account-keeper-template">Template</label>
            <div className="account-keeper__picker">
              <input
                id="account-keeper-template"
                value={draft.templateText}
                placeholder="Enter a batch template"
                aria-describedby={draft.templateValidation ? "account-keeper-template-validation" : undefined}
                onChange={(event) => setDraft((current) => ({
                  ...current,
                  templateText: event.target.value,
                  templateValidation: null,
                }))}
              />
              <button
                type="button"
                className="btn-ghost"
                onClick={() => void validateTemplate()}
                disabled={!draft.templateText.trim() || busyAction !== null}
              >
                Validate Template
              </button>
            </div>
            {draft.templateValidation && (
              <div
                id="account-keeper-template-validation"
                role="status"
                aria-live="polite"
                className={`account-keeper__validation ${draft.templateValidation.valid ? "is-valid" : "is-invalid"}`}
              >
                <strong>{draft.templateValidation.valid ? "Template valid" : "Template needs attention"}</strong>
                <span>Length {draft.templateValidation.finalLength}</span>
                <span>
                  {[
                    draft.templateValidation.hasUppercase && "Uppercase",
                    draft.templateValidation.hasLowercase && "Lowercase",
                    draft.templateValidation.hasDigit && "Digit",
                    draft.templateValidation.hasSymbol && "Symbol",
                  ].filter(Boolean).join(" · ")}
                </span>
              </div>
            )}
          </div>
          )}

          {draft.operation !== "login" && (
          <div className="account-keeper__field">
            <label htmlFor="account-keeper-output">Output file</label>
            <div className="account-keeper__picker">
              <input
                id="account-keeper-output"
                value={draft.outputPath}
                placeholder="Choose a local JSON file"
                onChange={(event) => setDraft((current) => ({
                  ...current,
                  outputPath: event.target.value,
                }))}
              />
              <button
                type="button"
                className="btn-ghost"
                aria-label="Choose output file"
                onClick={() => void chooseOutput()}
                disabled={busyAction !== null}
              >
                Browse
              </button>
            </div>
          </div>
          )}

          <label className="account-keeper__toggle">
            <input
              type="checkbox"
              checked={draft.keepProfileRunning}
              onChange={(event) => setDraft((current) => ({
                ...current,
                keepProfileRunning: event.target.checked,
              }))}
            />
            <span>
              <strong>Keep profile running after completion</strong>
              <small>Leave completed profiles open for operator review.</small>
            </span>
          </label>

          <label className="account-keeper__warning-check">
            <input
              type="checkbox"
              checked={draft.plaintextAcknowledged}
              onChange={(event) => setDraft((current) => ({
                ...current,
                plaintextAcknowledged: event.target.checked,
              }))}
            />
            <span>
              {draft.inputMode === "inline"
                ? "I understand pasted input and the output file contain plaintext secrets"
                : "I understand the selected input and output files contain plaintext secrets"}
            </span>
          </label>

          <div className="account-keeper__primary-actions">
            <button type="button" className="btn-primary" onClick={() => void startBatch()} disabled={!startEnabled}>
              {draft.operation === "login" ? "Login & Save Profile" : "Start Batch"}
            </button>
            <button
              type="button"
              className="btn-ghost"
              onClick={() => void pauseAfterCurrent()}
              disabled={!activeJob || activeJob.pause_after_current || busyAction !== null}
            >
              Pause After Current
            </button>
            <button
              type="button"
              className="btn-ghost danger"
              onClick={() => void cancelBatch()}
              disabled={!activeJob || busyAction !== null}
            >
              Cancel Batch
            </button>
          </div>
        </section>

        <aside className="account-keeper__panel account-keeper__jobs" aria-labelledby="account-keeper-jobs-title">
          <div className="account-keeper__panel-head">
            <div>
              <span className="account-keeper__step">02</span>
              <h2 id="account-keeper-jobs-title">Resumable jobs</h2>
            </div>
          </div>
          {resumableJobs.length === 0 ? (
            <p className="account-keeper__empty">No incomplete jobs.</p>
          ) : (
            <div className="account-keeper__job-list">
              {resumableJobs.map((job) => (
                <article
                  key={job.batch_id}
                  className={`account-keeper__job ${selectedJob?.batch_id === job.batch_id ? "is-selected" : ""}`}
                >
                  <button
                    type="button"
                    className="account-keeper__job-select"
                    onClick={() => setSelectedJobId(job.batch_id)}
                    aria-label={`View job ${shortJobId(job.batch_id)}`}
                  >
                    <span>
                      <strong>{shortJobId(job.batch_id)}</strong>
                      <small>{completedCount(job)} / {job.accounts.length} complete</small>
                    </span>
                    <span className={`account-keeper__status is-${job.status}`}>{labelFor(job.status)}</span>
                  </button>
                  <div className="account-keeper__job-actions">
                    <button
                      type="button"
                      className="btn-sm"
                      onClick={() => void resumeJob(job)}
                      disabled={!canResume(job) || busyAction !== null}
                    >
                      Resume Job
                    </button>
                    <button type="button" className="btn-sm" onClick={() => void exportResult(job)} disabled={busyAction !== null}>
                      Export Result
                    </button>
                    <button type="button" className="btn-sm danger" onClick={() => void abandonJob(job)} disabled={busyAction !== null}>
                      Abandon Job
                    </button>
                  </div>
                </article>
              ))}
            </div>
          )}
        </aside>
      </div>

      <section className="account-keeper__panel account-keeper__progress" aria-labelledby="account-keeper-progress-title">
        <div className="account-keeper__panel-head account-keeper__progress-head">
          <div>
            <span className="account-keeper__step">03</span>
            <h2 id="account-keeper-progress-title">Progress</h2>
          </div>
          <div className="account-keeper__progress-side">
            {selectedJob && (
              <div className="account-keeper__progress-meta">
                <span>Job {shortJobId(selectedJob.batch_id)}</span>
                <span>{completedCount(selectedJob)} / {selectedJob.accounts.length}</span>
                <span className={`account-keeper__status is-${selectedJob.status}`}>{labelFor(selectedJob.status)}</span>
              </div>
            )}
            <div className="account-keeper__progress-actions">
              <button
                type="button"
                className="btn-sm"
                aria-pressed={showLogs}
                onClick={() => setShowLogs((current) => !current)}
                disabled={!selectedJob || busyAction !== null}
              >
                Logs
              </button>
              <button
                type="button"
                className="btn-sm danger"
                onClick={() => void cleanProgress()}
                disabled={!isCleanableJob(selectedJob) || busyAction !== null}
              >
                Clean
              </button>
            </div>
          </div>
        </div>

        {selectedJob && (selectedJob.status === "waiting_manual" || activeAccount?.stage === "waiting_manual") && activeAccount && (
          <div className="account-keeper__manual" role="status">
            <div>
              <strong>Manual action required for {activeAccount.masked_account}</strong>
              <p>{activeAccount.error_code ?? "Complete the visible browser challenge, then continue."}</p>
            </div>
            <div className="account-keeper__manual-actions">
              <button type="button" className="btn-primary" onClick={() => void continueManual()} disabled={busyAction !== null}>
                Continue
              </button>
              <button type="button" className="btn-ghost danger" onClick={() => void markFailed()} disabled={busyAction !== null}>
                Mark Failed
              </button>
              <button
                type="button"
                className="btn-ghost"
                onClick={() => void openProfile(activeAccount)}
                disabled={!activeAccount.profile_id || busyAction !== null}
              >
                Open Profile
              </button>
            </div>
          </div>
        )}

        {showLogs && (
          <div className="account-keeper__logs" role="region" aria-label="Progress logs">
            {selectedLogs.length === 0 ? (
              <p className="account-keeper__empty">No redacted progress logs.</p>
            ) : selectedLogs.map((entry) => (
              <div className="account-keeper__log" key={entry.key}>
                <time>{entry.updated_at || "Unknown time"}</time>
                <strong>{entry.masked_account}</strong>
                <span className={`account-keeper__stage is-${entry.stage}`}>{labelFor(entry.stage)}</span>
                <span>Attempt {entry.attempts}</span>
                {entry.error_code && <code>{entry.error_code}</code>}
              </div>
            ))}
          </div>
        )}

        <div className="account-keeper__table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">Masked account</th>
                <th scope="col">Profile</th>
                <th scope="col">Stage</th>
                <th scope="col">Attempts</th>
                <th scope="col">Error</th>
              </tr>
            </thead>
            <tbody>
              {!selectedJob || selectedJob.accounts.length === 0 ? (
                <tr><td colSpan={5} className="account-keeper__table-empty">No progress to display.</td></tr>
              ) : selectedJob.accounts.map((account) => (
                <tr key={account.account_key} className={account.stage === "critical" ? "is-critical" : ""}>
                  <td><strong>{account.masked_account}</strong></td>
                  <td><span className="account-keeper__mono">{account.profile_id ?? "Pending"}</span></td>
                  <td><span className={`account-keeper__stage is-${account.stage}`}>{labelFor(account.stage)}</span></td>
                  <td>{account.attempts}</td>
                  <td>
                    {account.error_code
                      ? <code>{account.error_code}</code>
                      : <span className="account-keeper__muted">{"\u2014"}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="account-keeper__panel account-keeper__profiles" aria-labelledby="account-keeper-profiles-title">
        <div className="account-keeper__panel-head">
          <div>
            <span className="account-keeper__step">04</span>
            <h2 id="account-keeper-profiles-title">Profiles</h2>
          </div>
          <span className="account-keeper__panel-note">{profiles.length} verified</span>
        </div>

        {readyCodexProfileIds.length > 0 && (
          <div className="account-keeper__bulk-export" role="group" aria-label="Bulk Codex export">
            <span>{readyCodexProfileIds.length} Codex account{readyCodexProfileIds.length === 1 ? "" : "s"} ready</span>
            <div className="account-keeper__profile-actions">
              <button type="button" className="btn-sm" aria-label="Copy all ready accounts for 9Router" onClick={() => void exportCodex(readyCodexProfileIds, "nine_router", "copy")} disabled={busyAction !== null}>Copy all to 9Router</button>
              <button type="button" className="btn-sm" aria-label="Save all ready accounts for 9Router" onClick={() => void exportCodex(readyCodexProfileIds, "nine_router", "save")} disabled={busyAction !== null}>Save all to 9Router</button>
              <button type="button" className="btn-sm" aria-label="Copy all ready accounts for Cockpit" onClick={() => void exportCodex(readyCodexProfileIds, "cockpit", "copy")} disabled={busyAction !== null}>Copy all to Cockpit</button>
              <button type="button" className="btn-sm" aria-label="Save all ready accounts for Cockpit" onClick={() => void exportCodex(readyCodexProfileIds, "cockpit", "save")} disabled={busyAction !== null}>Save all to Cockpit</button>
            </div>
          </div>
        )}

        {profiles.length === 0 ? (
          <p className="account-keeper__empty">Successful Account Keeper profiles appear here after new-password verification.</p>
        ) : (
          <div className="account-keeper__profile-list">
            {profiles.map((profile) => (
              <article className="account-keeper__profile" key={profile.profile_id}>
                <div className="account-keeper__profile-main">
                  <div>
                    <strong>{profile.masked_account}</strong>
                    <span className={`account-keeper__status is-${profile.status}`}>{labelFor(profile.status)}</span>
                    <span className={`account-keeper__badge ${profile.rotated ? "is-rotated" : "is-login"}`}>
                      {profile.rotated ? "Rotated" : "Logged in"}
                    </span>
                  </div>
                  <span className="account-keeper__mono">{profile.profile_id}</span>
                  <small>
                    {profile.running ? "Running" : "Stopped"}
                    {profile.last_verified_at ? ` · Verified ${profile.last_verified_at}` : ""}
                  </small>
                </div>
                <div className="account-keeper__profile-actions">
                  <button
                    type="button"
                    className="btn-sm"
                    aria-label={`Run profile ${profile.masked_account}`}
                    onClick={() => void openManagedProfile(profile)}
                    disabled={busyAction !== null}
                  >
                    Run
                  </button>
                  <button
                    type="button"
                    className="btn-sm"
                    aria-label={`${profile.codex_auth?.status === "ready" ? "Export" : "Connect Codex"} ${profile.masked_account}`}
                    onClick={() => profile.codex_auth?.status === "ready"
                      ? setImportProfileId((current) => current === profile.profile_id ? null : profile.profile_id)
                      : void connectCodex(profile)}
                    disabled={busyAction !== null}
                  >
                    {profile.codex_auth?.status === "ready"
                      ? "Export"
                      : profile.codex_auth?.status === "reconnect_required" ? "Reconnect Codex" : "Connect Codex"}
                  </button>
                  <button
                    type="button"
                    className="btn-sm danger"
                    aria-label={`Delete profile ${profile.masked_account}`}
                    onClick={() => void deleteManagedProfile(profile)}
                    disabled={busyAction !== null}
                  >
                    Delete
                  </button>
                </div>
              </article>
            ))}
          </div>
        )}

        {importProfile && (
          <div className="account-keeper__import" role="region" aria-label="9Router/Cockpit Codex export">
            <div>
              <strong>Codex OAuth export</strong>
              <p>Tokens stay hidden. Copy or save a directly importable JSON array.</p>
            </div>
            <p className="account-keeper__mono">Expires: {importProfile.codex_auth?.expires_at ?? "unknown"}</p>
            <div className="account-keeper__profile-actions">
              <button type="button" className="btn-sm" onClick={() => void exportCodex([importProfile.profile_id], "nine_router", "copy")} disabled={busyAction !== null}>Copy 9Router JSON</button>
              <button type="button" className="btn-sm" onClick={() => void exportCodex([importProfile.profile_id], "nine_router", "save")} disabled={busyAction !== null}>Save 9Router JSON</button>
              <button type="button" className="btn-sm" onClick={() => void exportCodex([importProfile.profile_id], "cockpit", "copy")} disabled={busyAction !== null}>Copy Cockpit JSON</button>
              <button type="button" className="btn-sm" onClick={() => void exportCodex([importProfile.profile_id], "cockpit", "save")} disabled={busyAction !== null}>Save Cockpit JSON</button>
            </div>
          </div>
        )}
      </section>
    </section>
  );
}
