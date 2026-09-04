export type AccountStage =
  | "queued"
  | "launching"
  | "logging_in"
  | "submitting_totp"
  | "changing_password"
  | "verifying_new_password"
  | "changing_totp"
  | "verifying_new_totp"
  | "changing_email"
  | "waiting_email_verification"
  | "verifying_new_email"
  | "waiting_manual"
  | "success"
  | "failed"
  | "critical"
  | "cancelled";

export type JobStatus =
  | "queued"
  | "running"
  | "paused"
  | "waiting_manual"
  | "completed"
  | "failed"
  | "critical"
  | "cancelled"
  | "abandoned";

export type InputSource =
  | { kind: "inline"; text: string }
  | { kind: "file"; path: string };
export type InputMode = InputSource["kind"];

export interface InputValidationDto {
  validCount: number;
  maskedAccounts: string[];
}

export interface AccountKeeperDefaultsDto {
  template: string;
  outputPath: string;
}

export interface TemplateValidationDto {
  valid: boolean;
  finalLength: number;
  hasUppercase: boolean;
  hasLowercase: boolean;
  hasDigit: boolean;
  hasSymbol: boolean;
}

export interface AccountView {
  account_key: string;
  masked_account: string;
  profile_id: string | null;
  stage: AccountStage;
  attempts: number;
  updated_at: string;
  error_code: string | null;
}

export interface JobView {
  batch_id: string;
  status: JobStatus;
  updated_at: string;
  output_path: string;
  keep_profile_running: boolean;
  pause_after_current: boolean;
  accounts: AccountView[];
  revision: number;
  batchBlocked: boolean;
}

export interface ProgressEvent {
  revision: number;
  job: JobView;
}

export interface ProgressLogEntry {
  key: string;
  updated_at: string;
  masked_account: string;
  stage: AccountStage;
  attempts: number;
  error_code: string | null;
}

export interface ManagedProfileView {
  profile_id: string;
  masked_account: string;
  status: "success";
  last_verified_at: string | null;
  running: boolean;
  rotated: boolean;
  codex_auth: {
    status: "missing" | "ready" | "reconnect_required";
    expires_at: string | null;
    has_account_id: boolean;
  };
}

export interface DraftState {
  operation: "login" | "change_password" | "change_totp" | "change_email";
  inputMode: InputMode;
  inputText: string;
  inputPath: string;
  inputRevision: number;
  inputValidationRevision: number | null;
  outputPath: string;
  templateText: string;
  proxySelection: string;
  keepProfileRunning: boolean;
  plaintextAcknowledged: boolean;
  inputValidation: InputValidationDto | null;
  templateValidation: TemplateValidationDto | null;
}
