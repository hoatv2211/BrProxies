# Account Keeper Design

## Status

Approved design for a Windows-only MVP integrated into the BrProxies desktop app.

## Goal

Add an Account Keeper screen that imports multiple authorized account records, assigns one persistent BrProxies profile to each account, performs direct email/password login, generates TOTP codes locally, changes passwords from one batch template, verifies the new password by signing in again, and writes a resumable local result file.

The feature is for accounts the operator owns or is explicitly authorized to manage.

## Non-Goals

- Exporting or exposing browser cookies, session data, upstream access tokens, or refresh tokens.
- Solving or bypassing CAPTCHA, device approval, unusual-login warnings, or other security challenges.
- Logging into an email inbox to collect verification messages.
- Supporting Google, Microsoft, Apple, or other social-login flows in the MVP.
- Running multiple account jobs concurrently.
- Integrating directly with 9router or Cockpit in the MVP.
- Testing against real production accounts in automated tests.

## MVP Constraints

- Windows 10 and Windows 11 only.
- Direct account/password authentication with an optional TOTP challenge.
- One account is processed at a time.
- One persistent BrProxies profile is mapped to each account.
- Input and requested output files are local plaintext files.
- The internal credential vault is encrypted with Windows DPAPI.
- The operator must explicitly start each batch and confirm once that the batch will change passwords.

## Architecture

The feature has three layers:

1. **React Account Keeper UI** presents import validation, the password template, output location, batch progress, manual-intervention controls, and per-account results.
2. **Rust coordinator** owns parsing, validation, profile mapping, encrypted persistence, job state, TOTP generation, password generation, retries, checkpointing, and output writes.
3. **Node/Patchright worker** connects to the launched BrProxies profile over CDP and performs browser DOM interactions. It receives only the credentials required for the current account, remains idle during manual intervention, and exits after a terminal state or cancellation.

The Node worker reuses the existing Patchright/CDP connection pattern instead of adding a second browser runtime. The React layer never talks directly to the worker and does not retain credentials in long-lived application state.

## Proposed File Boundaries

- `src/account-keeper/AccountKeeper.tsx`: Account Keeper screen and user actions.
- `src/account-keeper/types.ts`: UI-safe job and result types without secret fields.
- `src/account-keeper/AccountKeeper.css`: Account Keeper styles.
- `src-tauri/src/account_keeper.rs`: coordinator, state machine, Tauri commands, and progress events.
- `src-tauri/src/account_keeper_store.rs`: DPAPI vault and checkpoint persistence.
- `src-tauri/src/account_keeper_format.rs`: input parser, template parser, and output serializer.
- `automation/account-keeper-worker.mjs`: per-account Patchright automation worker.
- `automation/account-keeper-protocol.mjs`: newline-delimited JSON protocol validation and redaction.

The exact split may be reduced during implementation when a file would contain only trivial forwarding code, but browser automation, persistence, formatting, and UI responsibilities must remain separate.

## Input Format

The input is a UTF-8 text file with one account per line:

```text
account|current_password|totp_secret
```

Rules:

- Blank lines and lines whose first non-whitespace character is `#` are ignored.
- The account is the text before the first `|`.
- The TOTP secret is the text after the last `|`.
- The password is the text between those delimiters, so a password may contain `|`.
- Account and TOTP fields are trimmed. Password bytes are preserved exactly.
- Duplicate normalized accounts are rejected before the batch starts.
- A TOTP secret may be empty only when the account does not use TOTP.
- A non-empty TOTP secret must decode as Base32 after spaces and hyphens are removed.
- Validation errors identify the input line but never include password or TOTP contents.

No credential examples from chat, screenshots, logs, or development fixtures are copied into the repository.

## Password Template

The MVP supports one template for the entire batch:

```text
prefix{random:N}suffix
```

Rules:

- The template must contain exactly one `{random:N}` placeholder.
- `N` must be between 8 and 64.
- The final password must be between 12 and 128 characters.
- Random characters come from uppercase letters, lowercase letters, digits, and a conservative symbol set.
- Generation uses an operating-system cryptographic random source.
- Generated passwords are unique within the batch.
- The generated password is written only to the plaintext output file. The UI shows a fixed mask without receiving the value.

The UI previews the resulting length and character categories before the batch starts, but it does not generate actual account passwords during preview.

## Account And Profile Mapping

The coordinator derives a stable account key from the normalized account identifier and stores the mapping in the encrypted vault. A new account creates a persistent BrProxies profile with a masked display name such as `acct-1a2b3c4d`; an existing account reuses its mapped profile.

The vault stores:

- stable account key;
- original account identifier;
- current known password;
- TOTP secret when present;
- BrProxies `profile_id`;
- password state;
- last verified timestamp;
- last job and status metadata.

Passwords and TOTP secrets are encrypted with Windows DPAPI before being written. The vault must not expose decrypted values through Tauri commands or React events.

## Batch Execution Flow

For each account, the Rust coordinator performs the following sequence:

1. Load and decrypt only the current account record.
2. Create or resolve its persistent BrProxies profile.
3. Launch the profile with CDP enabled.
4. Spawn a fresh Node worker for this account.
5. Send the account identifier, current password, generated new password, and CDP endpoint through the worker's standard input.
6. Let the worker perform the direct login flow.
7. When the worker requests a TOTP code, generate the current code locally in Rust and send only that short-lived code to the worker.
8. Pause for manual intervention if the worker detects CAPTCHA, unusual-login approval, email verification, or an unknown security challenge.
9. Continue the supported password-change flow after explicit operator confirmation.
10. Sign out through the normal UI and sign in again with the new password.
11. Commit the new password to the encrypted vault only after verification succeeds.
12. Atomically update the checkpoint and plaintext output JSON.
13. Stop or preserve the profile according to the batch UI setting, then move to the next account.

The worker does not inspect, export, or return cookies, storage tokens, authorization headers, access tokens, or refresh tokens.

## TOTP Handling

TOTP codes are generated locally from the encrypted secret using the standard time-based one-time-password algorithm. The secret is never sent to a website, the React frontend, worker environment variables, command-line arguments, logs, or worker output streams.

The Node worker emits `totp_required` only when the expected TOTP form is visible. Rust returns one current code. If the code is rejected near a time-window boundary, Rust waits for the next window and permits one additional attempt. A second failure moves the account to manual intervention rather than repeatedly generating codes.

## Worker Protocol

Rust and the Node worker communicate with newline-delimited JSON over standard input and standard output.

Rust-to-worker messages:

- `start`: request ID, CDP endpoint, account identifier, current password, and proposed new password.
- `totp_code`: request ID and one short-lived TOTP code.
- `resume`: continue after the operator completes a manual challenge.
- `cancel`: stop the current account safely.

Worker-to-Rust messages:

- `stage`: normalized progress stage without page content.
- `totp_required`: request a locally generated code.
- `manual_required`: normalized reason plus URL origin and pathname, with query and fragment removed and without HTML or form values.
- `password_changed`: password submission was accepted but not yet verified.
- `verified`: sign-in with the new password succeeded.
- `failed`: normalized error code and redacted message.

Protocol parsing rejects unknown message types, oversized messages, missing request IDs, and any worker response containing fields named like passwords, secrets, cookies, tokens, or authorization headers.

## Job State Machine

Normal states:

```text
queued
launching
logging_in
submitting_totp
changing_password
verifying_new_password
success
```

Exceptional states:

- `waiting_manual`: browser security challenge requires the operator.
- `failed`: known failure where the next account may proceed.
- `critical`: password submission may have succeeded but the valid password cannot be determined.
- `cancelled`: operator cancelled the account or batch.

Only `success`, `failed`, `critical`, and `cancelled` are terminal for an account. A `critical` account stops the entire batch and keeps its browser profile open for recovery.

## Manual Intervention

When the worker reports a security challenge:

1. Rust checkpoints the account as `waiting_manual`.
2. The UI identifies the affected profile and brings its browser window to the operator's attention.
3. The worker remains connected but performs no actions.
4. The operator completes the challenge and clicks **Continue**.
5. The worker re-evaluates the expected supported stage before continuing.

There is no CAPTCHA solver, challenge-response service, stealth retry loop, or selector fallback intended to bypass platform protections. The operator may instead mark the account failed and continue the batch.

## Retry And Failure Policy

- Invalid current password: no retry; `invalid_credentials`.
- Invalid input or TOTP secret: reject before starting the batch.
- First TOTP rejection: wait for the next time window and retry once.
- Network or navigation failure: retry up to three times with bounded backoff.
- Browser/profile crash: restart the profile and worker once.
- Unsupported social-login account: `unsupported_login_method`.
- Supported page structure no longer recognized: `flow_changed`; do not guess or click by visual proximity.
- Password accepted but verification fails: `critical`; stop the batch.
- Operator cancellation before password submission: retain the original password state.
- Operator cancellation after password submission: `critical` until one credential is manually verified.

Error messages may include stage, normalized code, attempt count, and URL origin. They must not contain account identifiers, passwords, TOTP secrets, TOTP codes, DOM contents, or response bodies.

## Output JSON

The operator chooses a local plaintext JSON path. The coordinator updates it atomically after each account by writing a sibling temporary file and replacing the destination only after serialization succeeds.

```json
{
  schema_version: 1,
  batch_id: uuid,
  updated_at: 2026-07-29T00:00:00Z,
  accounts: [
    {
      account: user@example.com,
      password: current-known-password,
      password_state: changed,
      totp_secret: BASE32_SECRET,
      profile_id: profile-uuid,
      status: success,
      last_verified_at: 2026-07-29T00:00:00Z,
      error: null
    }
  ]
}
```

Output rules:

- `password` is the last known usable password.
- `password_state` is `original`, `changed`, or `unknown`.
- `status` is the terminal or checkpointed account state.
- Failed accounts retain the original password unless password state is uncertain.
- Critical accounts use `password_state: unknown` and stop the batch.
- The TOTP secret is included because the operator explicitly requested plaintext local management.
- The UI displays a plaintext-secret warning before the first write.
- The app does not create backups, diagnostic copies, or telemetry containing the output.

## Checkpoint And Resume

The encrypted internal checkpoint is updated after every state transition that changes credentials or operator responsibility. On restart, Account Keeper lists incomplete jobs and supports:

- resume from the next queued account;
- reopen a `waiting_manual` account profile;
- inspect a failed result without decrypting credentials into the UI;
- abandon a job while preserving its profile mappings;
- re-export the current plaintext result only after explicit confirmation.

The coordinator never automatically resumes a password-changing job when BrProxies starts.

## UI Design

The Account Keeper screen contains:

- input file picker;
- password-template field and validation summary;
- output JSON path picker;
- validated account count and duplicate/error summary;
- explicit acknowledgment that input and output files contain plaintext secrets;
- **Start Batch**, **Pause After Current**, and **Cancel Batch** controls;
- progress table with masked account, profile, stage, attempts, and status;
- manual intervention panel with **Continue**, **Mark Failed**, and **Open Profile**;
- critical recovery banner that prevents processing the next account;
- **Keep profile running after completion** toggle, disabled by default;
- resumable-job list.

The React UI receives redacted progress events. It never receives passwords, TOTP secrets, TOTP codes, or plaintext vault records.

## Security Requirements

- Process only accounts the operator owns or is authorized to manage.
- Never accept production credentials through development chat, source files, test fixtures, issue descriptions, or logs.
- Use DPAPI for internal secrets and cryptographic randomness for generated passwords.
- Pass account credentials only through the worker's standard input, never process arguments or environment variables.
- Keep the TOTP secret in Rust; send the worker only a current code when requested.
- Redact worker output before forwarding it to logs or React events.
- Prevent simultaneous workers in the MVP.
- Do not export browser sessions or upstream provider tokens.
- Do not attempt CAPTCHA solving or security-control bypasses.
- Treat any secret shown in chat or screenshots as compromised and unsuitable for testing.

## Future Adapter Boundary

Future 9router or Cockpit integration may consume stable `profile_id`, account status, and an operator-approved local reference to the encrypted vault. It must not require Account Keeper to export upstream browser session tokens. Any future provider OAuth or gateway-token integration requires a separate design and authorization review.

## Testing Strategy

Automated tests use synthetic credentials and local fixture pages only.

Rust tests cover:

- first/last delimiter parsing, including passwords containing `|`;
- duplicate account detection;
- Base32 validation without exposing the input value;
- template grammar and length limits;
- cryptographically generated password shape and batch uniqueness;
- TOTP generation against published test vectors;
- DPAPI vault round trips on Windows;
- state-machine transition validity;
- critical-state batch stopping;
- atomic output serialization;
- log and protocol redaction.

Node tests cover:

- protocol schema validation;
- supported synthetic login, TOTP, password-change, logout, and re-login pages;
- manual challenge detection;
- refusal to guess after fixture structure changes;
- secret-field rejection in worker responses.

UI tests cover:

- validation and plaintext warning gates;
- progress rendering from redacted events;
- manual intervention controls;
- critical-state blocking;
- resumable-job presentation.

A local end-to-end fixture server validates the complete Rust-to-worker-to-browser flow without contacting OpenAI, email providers, `2fa.live`, or any production authentication service.

## Acceptance Criteria

The MVP is complete when:

1. A valid plaintext input file can be previewed without exposing secrets in UI state or logs.
2. Each account receives or reuses one persistent BrProxies profile.
3. The batch processes exactly one account at a time.
4. TOTP is generated locally and filled automatically on the supported fixture flow.
5. CAPTCHA or unknown security challenges pause for manual intervention.
6. Passwords follow the approved template and are committed only after successful re-login.
7. A critical password-state ambiguity stops the batch.
8. Checkpoints survive app restart but never auto-resume destructive actions.
9. Output JSON is atomically updated after each account and matches schema version 1.
10. No cookie, session, access token, refresh token, or authorization header is exported.
11. Automated tests use only synthetic local fixtures and contain no production credentials.
