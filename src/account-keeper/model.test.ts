import { describe, expect, it } from "vitest";
import {
  activeInputSource,
  canResume,
  canStart,
  isCleanableJob,
  progressLogEntries,
  reduceProgress,
} from "./model";
import type {
  AccountView,
  DraftState,
  JobView,
  ProgressEvent,
} from "./types";

const validDraft: DraftState = {
  operation: "change_password",
  inputMode: "inline",
  inputText: "owner@example.test|current-password|JBSWY3DPEHPK3PXP",
  inputPath: "C:\\fixtures\\batch.txt",
  inputRevision: 1,
  inputValidationRevision: 1,
  outputPath: "C:\\fixtures\\result.json",
  templateText: "Local-{random:16}",
  keepProfileRunning: false,
  plaintextAcknowledged: true,
  inputValidation: {
    validCount: 2,
    maskedAccounts: ["o***r@example.test", "a***n@example.test"],
  },
  templateValidation: {
    valid: true,
    finalLength: 22,
    hasUppercase: true,
    hasLowercase: true,
    hasDigit: true,
    hasSymbol: true,
  },
};

const validFileDraft: DraftState = {
  ...validDraft,
  inputMode: "file",
  inputPath: "C:\\fixtures\\file-batch.txt",
  inputRevision: 2,
  inputValidationRevision: 2,
  inputValidation: {
    validCount: 1,
    maskedAccounts: ["f***e@example.test"],
  },
};

describe("activeInputSource", () => {
  it("builds only the active tagged source", () => {
    expect(activeInputSource(validDraft)).toEqual({ kind: "inline", text: validDraft.inputText });
    expect(activeInputSource(validFileDraft)).toEqual({ kind: "file", path: validFileDraft.inputPath });
  });
});
const queuedAccount: AccountView = {
  account_key: "account-1",
  masked_account: "o***r@example.test",
  profile_id: "profile-1",
  stage: "queued",
  attempts: 0,
  updated_at: "2026-07-29T00:00:00Z",
  error_code: null,
};

const runningJob: JobView = {
  batch_id: "job-1",
  status: "running",
  revision: 4,
  updated_at: "2026-07-29T00:01:00Z",
  output_path: "C:\\fixtures\\result.json",
  keep_profile_running: false,
  pause_after_current: false,
  batchBlocked: false,
  accounts: [queuedAccount],
};

function event(job: JobView, revision = 5): ProgressEvent {
  return { revision, job: { ...job, revision } };
}

describe("canStart", () => {
  it("requires plaintext acknowledgement", () => {
    expect(canStart({ ...validDraft, plaintextAcknowledged: false }, [])).toBe(false);
    expect(canStart(validDraft, [])).toBe(true);
  });

  it("rejects invalid or incomplete drafts", () => {
    expect(canStart({ ...validDraft, inputText: "" }, [])).toBe(false);
    expect(canStart({ ...validDraft, outputPath: "   " }, [])).toBe(false);
    expect(canStart({ ...validDraft, inputValidation: null }, [])).toBe(false);
    expect(canStart({ ...validDraft, templateValidation: null }, [])).toBe(false);
    expect(canStart({
      ...validDraft,
      inputValidation: { validCount: 0, maskedAccounts: [] },
    }, [])).toBe(false);
    expect(canStart({
      ...validDraft,
      templateValidation: {
        valid: false,
        finalLength: 0,
        hasUppercase: false,
        hasLowercase: false,
        hasDigit: false,
        hasSymbol: false,
      },
    }, [])).toBe(false);
  });

  it("requires content for the active source only", () => {
    expect(canStart({ ...validDraft, inputText: "" }, [])).toBe(false);
    expect(canStart({ ...validDraft, inputPath: "" }, [])).toBe(true);
    expect(canStart({ ...validFileDraft, inputPath: "" }, [])).toBe(false);
    expect(canStart({ ...validFileDraft, inputText: "" }, [])).toBe(true);
    expect(canStart({ ...validDraft, inputText: "   " }, [])).toBe(false);
    expect(canStart({ ...validFileDraft, inputPath: "   " }, [])).toBe(false);
  });

  it("rejects validation from an older input revision", () => {
    expect(canStart({ ...validDraft, inputRevision: 2 }, [])).toBe(false);
    expect(canStart({ ...validFileDraft, inputMode: "inline", inputRevision: 3 }, [])).toBe(false);
    expect(canStart(validFileDraft, [])).toBe(true);
  });

  it("rejects active or blocking jobs", () => {
    expect(canStart(validDraft, [runningJob])).toBe(false);
    expect(canStart(validDraft, [{ ...runningJob, status: "waiting_manual" }])).toBe(false);
    expect(canStart(validDraft, [{ ...runningJob, status: "critical", batchBlocked: true }])).toBe(false);
    expect(canStart(validDraft, [{ ...runningJob, status: "completed" }])).toBe(true);
  });
});
describe("canStart operation modes", () => {
  const loginDraft: DraftState = {
    ...validDraft,
    operation: "login",
    outputPath: "",
    templateText: "",
    templateValidation: null,
  };

  it("allows a login draft with no template or output", () => {
    expect(canStart(loginDraft, [])).toBe(true);
  });

  it("still requires template and output for change_password", () => {
    const changeDraft: DraftState = {
      ...validDraft,
      operation: "change_password",
      outputPath: "",
    };
    expect(canStart(changeDraft, [])).toBe(false);
  });

  it("login draft still requires valid input and acknowledgement", () => {
    expect(canStart({ ...loginDraft, plaintextAcknowledged: false }, [])).toBe(false);
    expect(canStart({ ...loginDraft, inputValidation: null }, [])).toBe(false);
  });

  it.each(["change_totp", "change_email"] as const)(
    "%s requires output but not a password template",
    (operation) => {
      const securityDraft: DraftState = {
        ...validDraft,
        operation,
        templateText: "",
        templateValidation: null,
      };
      expect(canStart(securityDraft, [])).toBe(true);
      expect(canStart({ ...securityDraft, outputPath: "" }, [])).toBe(false);
    },
  );
});

describe("canResume", () => {
  it("allows jobs with resumable account work", () => {
    expect(canResume(runningJob)).toBe(true);
    expect(canResume({
      ...runningJob,
      accounts: [{ ...queuedAccount, stage: "verifying_new_password" }],
    })).toBe(true);
  });

  it("rejects manual-only, blocked, and terminal jobs", () => {
    expect(canResume({
      ...runningJob,
      status: "waiting_manual",
      accounts: [{ ...queuedAccount, stage: "waiting_manual" }],
    })).toBe(false);
    expect(canResume({
      ...runningJob,
      status: "critical",
      batchBlocked: true,
      accounts: [{ ...queuedAccount, stage: "critical" }],
    })).toBe(false);
    expect(canResume({ ...runningJob, status: "completed" })).toBe(false);
  });
});

describe("reduceProgress", () => {
  it("ignores stale revisions", () => {
    const next = reduceProgress(
      [runningJob],
      event({ ...runningJob, status: "completed" }, 4),
    );
    expect(next[0]).toBe(runningJob);
  });

  it("updates the matching account and enters manual waiting", () => {
    const manualAccount: AccountView = {
      ...queuedAccount,
      stage: "waiting_manual",
      attempts: 1,
      updated_at: "2026-07-29T00:02:00Z",
      error_code: "manual_required",
    };
    const next = reduceProgress(
      [runningJob],
      event({ ...runningJob, status: "waiting_manual", accounts: [manualAccount] }),
    );

    expect(next[0].status).toBe("waiting_manual");
    expect(next[0].accounts[0]).toEqual(manualAccount);
  });

  it("sets a critical blocker", () => {
    const criticalAccount: AccountView = {
      ...queuedAccount,
      stage: "critical",
      attempts: 2,
      error_code: "verification_failed",
    };
    const next = reduceProgress(
      [runningJob],
      event({ ...runningJob, status: "critical", accounts: [criticalAccount] }),
    );

    expect(next[0].status).toBe("critical");
    expect(next[0].batchBlocked).toBe(true);
  });

  it("resumes manual work without clearing a critical blocker", () => {
    const manualJob: JobView = {
      ...runningJob,
      status: "waiting_manual",
      accounts: [{ ...queuedAccount, stage: "waiting_manual" }],
    };
    const resumed = reduceProgress(
      [manualJob],
      event({ ...manualJob, status: "running", accounts: [{ ...queuedAccount, stage: "launching" }] }),
    );
    expect(resumed[0].status).toBe("running");
    expect(resumed[0].batchBlocked).toBe(false);

    const blockedJob: JobView = {
      ...manualJob,
      status: "critical",
      batchBlocked: true,
      accounts: [{ ...queuedAccount, stage: "critical" }],
    };
    const blockedResume = reduceProgress(
      [blockedJob],
      event({ ...blockedJob, status: "running" }),
    );
    expect(blockedResume[0].status).toBe("critical");
    expect(blockedResume[0].batchBlocked).toBe(true);
  });

  it("handles completion and cancellation as safe terminal snapshots", () => {
    const completed = reduceProgress([runningJob], event({ ...runningJob, status: "completed" }));
    expect(completed[0]).toMatchObject({ status: "completed", batchBlocked: false });

    const cancelled = reduceProgress([runningJob], event({ ...runningJob, status: "cancelled" }));
    expect(cancelled[0]).toMatchObject({ status: "cancelled", batchBlocked: false });
  });
});

describe("progress management", () => {
  it("allows cleaning safe terminal jobs only", () => {
    expect(isCleanableJob({ ...runningJob, status: "completed" })).toBe(true);
    expect(isCleanableJob({ ...runningJob, status: "failed" })).toBe(true);
    expect(isCleanableJob({ ...runningJob, status: "cancelled" })).toBe(true);
    expect(isCleanableJob(runningJob)).toBe(false);
    expect(isCleanableJob({ ...runningJob, status: "critical", batchBlocked: true })).toBe(false);
  });

  it("builds redacted progress log entries from the selected snapshot", () => {
    const entries = progressLogEntries({
      ...runningJob,
      status: "failed",
      accounts: [{
        ...queuedAccount,
        stage: "failed",
        attempts: 1,
        error_code: "flow_changed",
        updated_at: "2026-07-31T03:03:40Z",
      }],
    });

    expect(entries).toEqual([{
      key: "account-1:2026-07-31T03:03:40Z:failed",
      updated_at: "2026-07-31T03:03:40Z",
      masked_account: "o***r@example.test",
      stage: "failed",
      attempts: 1,
      error_code: "flow_changed",
    }]);
  });
});
