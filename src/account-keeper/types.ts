export type AccountStage =
  | "queued"
  | "launching"
  | "logging_in"
  | "submitting_totp"
  | "changing_password"
  | "verifying_new_password"
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

export interface DraftState {
  inputMode: InputMode;
  inputText: string;
  inputPath: string;
  inputRevision: number;
  inputValidationRevision: number | null;
  outputPath: string;
  templateText: string;
  keepProfileRunning: boolean;
  plaintextAcknowledged: boolean;
  inputValidation: InputValidationDto | null;
  templateValidation: TemplateValidationDto | null;
}
