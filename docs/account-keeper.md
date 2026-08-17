# Account Keeper

[README](../README.md) | [Tiếng Việt](account-keeper.vn.md)

Account Keeper is the Windows 10/11 BrProxies workflow for logging in and changing
passwords, authenticator 2FA, or account email on accounts you own or are explicitly authorized to manage. It processes
one account at a time and maps every account to one persistent BrProxies
profile.

## Safety And Scope

Account Keeper changes credentials. Read these boundaries before using it:

- Use it only for operator-owned or explicitly authorized accounts.
- Never paste production credentials into documentation, tests, issues, logs,
  screenshots, development chat, or support chat.
- Account Keeper does not solve or bypass CAPTCHA, device approval, unusual
  login warnings, email verification, or other security controls.
- It does not log in to inboxes or automate email-message retrieval.
- Change email can call an optional operator-provided loopback mailbox connector
  for a six-digit verification code. If unavailable, the profile stays open for manual verification.
- Social login through Google, Microsoft, Apple, or another identity provider
  is not supported in the MVP.
- It does not export cookies, browser sessions, authorization headers, access
  tokens, or refresh tokens.
- TOTP secrets remain local. Rust generates a short-lived six-digit code and
  sends only that code to the worker when the expected TOTP form is visible.

Pasted input, selected input files, and requested output files contain
plaintext secrets. Pasted text may remain exposed through the system clipboard,
clipboard history, or process memory. Clear sensitive clipboard contents after
pasting, and store plaintext input and output files only in a trusted local
location with appropriate Windows file permissions.

## Platform And Runtime

- Supported platform: Windows 10 and Windows 11.
- Execution model: one account and one worker at a time.
- Browser model: one persistent BrProxies profile per normalized account.
- Release builds include a Windows Node runtime, the Account Keeper worker,
  Patchright, Patchright Core, protocol modules, and provider adapters.
- The worker connects to the launched BrProxies profile through CDP. It does
  not download or launch a separate Playwright browser.
- Debug builds prefer bundled resources when available. If they are absent,
  the debug-only fallback uses `automation/` and requires system `node` on
  `PATH`. Release builds do not use this fallback.

## Background Daemon And MCP

The built BrProxies app starts an in-process Account Keeper daemon. Keep
BrProxies running while jobs execute; closing the MCP client does not stop the
active job.

- Jobs use FIFO order with one active Account Keeper job at a time.
- Job requests are stored locally in a DPAPI-protected daemon file.
- MCP and the Automation API accept local input/output paths only. Never pass
  accounts, passwords, TOTP secrets, cookies, or tokens in tool arguments.
- Creating a job requires `authorize_password_change: true`.
- Use `account_keeper_list_jobs` or `account_keeper_get_job` for redacted
  status. Responses omit input/output paths and all credential fields.
- Use `account_keeper_continue_job` only after completing the visible CAPTCHA,
  email verification, device approval, or other security challenge manually.
- On BrProxies restart, an interrupted job becomes `recovery_required`. It is
  never resumed automatically; call `account_keeper_resume_job` explicitly.
- Use `account_keeper_cancel_job` to cancel through the normal password-state
  safety rules. Cancellation after password submission may produce a critical
  unknown credential state.

Available MCP tools:

```text
account_keeper_create_job
account_keeper_list_jobs
account_keeper_get_job
account_keeper_continue_job
account_keeper_resume_job
account_keeper_cancel_job
```

## Prepare Input Records

Provide records as pasted text or a UTF-8 plaintext file. Both input modes use
this format, with one record per line:

```text
account|current_password|optional_totp_secret
```

For **Change email**, append the new email as the fourth field:

```text
current_email|current_password|optional_totp_secret|new_email
```

The first email identifies the existing profile. The fourth field is the new
email and is committed only after provider verification.

Required synthetic example:

```text
owner@example.test|current-password|JBSWY3DPEHPK3PXP
```

An account without TOTP still needs the final delimiter:

```text
owner@example.test|current-password|
```

Parser rules:

- Blank lines are ignored.
- A line is a comment when its first non-whitespace character is `#`.
- Every active line requires at least two `|` delimiters.
- The account is everything before the first `|`; surrounding whitespace is
  trimmed, and the account cannot be empty.
- The TOTP secret is everything after the last `|`; surrounding whitespace is
  trimmed.
- The current password is everything between the first and last delimiters.
  Its bytes, spaces, and additional `|` characters are preserved exactly.
- Accounts are normalized with trim plus lowercase. Duplicate normalized
  accounts reject the input before the batch starts.
- An empty TOTP field is allowed. A non-empty value must be valid Base32.
  Base32 is case-insensitive; spaces and hyphens are ignored; valid trailing
  `=` padding is accepted.
- Validation errors report the line number but do not echo passwords or TOTP
  secrets.
- The fourth field is accepted only for **Change email**, must be a valid email,
  and must differ from the normalized current email.

Example with an internal password delimiter:

```text
owner@example.test|part|two|JBSWY3DPEHPK3PXP
```

The parsed password is `part|two` because the parser uses the first and last
delimiters.

## Password Template

One template applies to the whole batch. Its exact grammar is:

```text
prefix{random:N}suffix
```

Rules:

- The case-sensitive template must contain exactly one `{random:N}`
  placeholder.
- `N` contains ASCII digits and must be from 8 through 64.
- Prefix and suffix are literal text and may be empty.
- Final password length, including prefix and suffix, must be from 12 through
  128 characters.
- The random section uses only uppercase letters, lowercase letters, digits,
  and `!@#$%^&*_-+=?`.
- Every random section contains at least one uppercase letter, one lowercase
  letter, one digit, and one symbol.
- Generation uses the operating-system cryptographic random source.
- Generated passwords are unique within the batch. The generator makes at
  most 128 attempts to find a unique value.

Valid synthetic templates:

```text
BrP@{random:16}!
team-{random:24}
{random:12}-AK
```

Invalid examples include a missing placeholder, two placeholders,
`{random:7}`, `{random:65}`, a non-numeric length, or any template whose final
length is outside 12-128 characters.

## Start A Batch

1. Open **Account Keeper** in BrProxies.
2. Select **Login GPT**, **Change password**, **Change 2FA**, or **Change email**.
3. Keep the default **Paste text** mode selected and paste one record per line,
   or click **Choose file**, then **Browse** under **Input file**, and select a
   UTF-8 plaintext input file.
4. For pasted text, click **Validate Input** explicitly. A selected file is
   validated immediately after selection.
5. For change operations, keep the default `%USERPROFILE%\Documents\account-keeper-result.json`, or
   click **Browse** under **Output file** and choose another plaintext output
   JSON path.
6. For **Change password** only, enter the batch password template, then click **Validate Template**.
7. Review the masked account identities, parsed account count, and any
   line-specific errors.
8. Acknowledge that the active input and output contain plaintext secrets.
9. Optionally enable **Keep profile running after completion**. It is disabled
   by default.
10. Click **Start Batch** and confirm the selected operation.

### Optional mailbox connector

Configure it under **Settings** > **Account Keeper email verification**. The
endpoint must use loopback HTTP and may return one of these strict responses:

```json
{"status":"code","code":"123456"}
{"status":"pending"}
{"status":"manual"}
```

Timeouts, connector errors, or `manual` fall back to manual **Continue**. The
connector token stays in local settings and is never sent to the browser worker.

Validation and start each send `request.source` through local React-to-Tauri
IPC. Paste mode sends `{ kind: "inline", text }`; file mode sends
`{ kind: "file", path }`. Rust parses pasted text in memory and reads the
selected file directly; no temporary plaintext input file is created. For
status reporting, the UI receives
masked account identities, profile IDs, stages, attempts, timestamps, and
redacted errors. After a successful start, the UI clears the pasted draft. This
does not erase or zeroize copies that may remain in process memory.

- Pasted input is never stored in settings, checkpoints, jobs, events, logs,
  diagnostics, or output metadata.
- Switching modes preserves unsent drafts but clears stale validation. A
  successful start clears the pasted draft.

## Batch Behavior

For each account, Account Keeper:

1. Resolves or creates the account's persistent BrProxies profile.
2. Launches that profile with CDP enabled.
3. Starts a fresh Node/Patchright worker for the account.
4. Classifies the current session. If the profile is already signed in, it
   skips credential submission and opens the settings surface for the selected operation.
   Otherwise it signs in with direct email/password.
5. Generates a local TOTP code only when requested by the visible TOTP form.
6. Pauses for manual action when a security challenge appears.
7. Submits the generated password through the supported provider flow.
8. Signs out and signs in again with the new password.
9. Marks the password `changed` only after the new sign-in is verified.
10. Atomically updates the checkpoint and plaintext output.
11. Stops the profile unless the keep-profile toggle is enabled, then starts
    the next account.

Normal stages also include `changing_totp`, `verifying_new_totp`,
`changing_email`, `waiting_email_verification`, and `verifying_new_email`.
Exceptional
states are `waiting_manual`, `failed`, `critical`, and `cancelled`.

## Batch Controls

- **Pause After Current** lets the current account reach a safe boundary, then
  pauses before the next account. It does not interrupt an in-progress
  password submission.
- **Cancel Batch** cancels the current operation and remaining queue. A cancel
  before password submission retains `password_state: original`; a cancel
  after submission becomes critical because the accepted password is unknown.
- **Keep profile running after completion** controls whether a normally
  completed profile process remains open. The persistent profile and its
  user-data directory remain mapped even when the process is stopped.
- **Logs** shows a redacted snapshot for the selected job: timestamp, masked
  account, stage, attempt count, and canonical error code only.
- **Clean** removes a selected terminal progress checkpoint with status
  `completed`, `failed`, `cancelled`, or `abandoned`. If the checkpoint contains
  an account whose encrypted vault state is `unknown`, Clean also forgets that
  recovery record so the account can be imported again. It is disabled for
  active and `critical` jobs; verified accounts and browser profile data remain.

## Verified Profiles

Section **04 Profiles** lists only vault records that completed new-password
verification with `status: success` and `password_state: changed`.

- **Run** launches the persistent mapped profile.
- **Delete** stops the profile, removes its local browser data, and deletes its
  Account Keeper vault mapping.
- **Import Info** exposes local metadata for 9Router or Cockpit. **Copy JSON**
  copies the same payload.

The import payload contains `schema_version`, `kind`, `profile_id`,
`account_status`, `last_verified_at`, `api_base_url`, and an opaque `vault_ref`.
It never contains the account identifier, password, TOTP secret, cookies,
access tokens, refresh tokens, or browser-session data.

## Manual Intervention

When Account Keeper enters `waiting_manual`, the worker stays connected but
performs no browser actions.

- Click **Open Profile** to bring the mapped browser profile into view.
- Complete the provider's challenge yourself.
- Click **Continue** only after the page has reached the expected supported
  step. The worker re-evaluates the page before acting.
- Click **Mark Failed** to stop this account as a known failure instead of
  continuing it. The next account may proceed when no critical state exists.

Manual reasons include CAPTCHA, email verification, security challenge,
unusual-login approval, and an unknown challenge. Account Keeper does not
solve, route around, or repeatedly guess through these checks.

### OpenAI And ChatGPT Password Recovery

The OpenAI/ChatGPT adapter uses direct email/password login. Password changes
may require the provider's official **Forgot Password** flow. If OpenAI asks
you to check email, Account Keeper pauses for manual email verification:

1. Click **Open Profile**.
2. Open your email account yourself and use the official recovery message.
3. Complete the provider flow in the mapped BrProxies profile.
4. Return to Account Keeper and click **Continue**.

Account Keeper does not log in to the inbox, read messages, extract links, or
claim to automate email verification.

## Critical Recovery

`credential_state_unknown` is a critical safety state. It means password
submission may have occurred, but Account Keeper could not verify whether the
old or proposed password is currently valid.

Critical behavior is strict:

- The account becomes `critical` with `password_state: unknown`.
- The entire batch stops immediately. No later account starts.
- The affected browser profile stays open for operator recovery, regardless of
  the normal keep-profile setting.
- The checkpoint and output preserve the unknown state. Account Keeper does
  not guess which password succeeded.
- Cancelling after the password-submit action has started also produces this
  state.

Use **Open Profile** and the provider's official recovery process to establish
a known valid credential. Do not resume the remaining queue while the
credential state is unknown. If the job cannot be safely continued, use
**Abandon**; the persistent profile mapping is preserved. Use **Export Result**
only after confirming that it will write the current secret-bearing state to a
plaintext JSON file.

**Verify & Resolve** re-verifies the attempted (proposed) password against the
live login. If it signs in, Account Keeper promotes the proposed password to the
current one, flips the account to `success` / `password_state: changed`, labels
the browser profile (see below), and rewrites the output. It only proceeds when
the attempted password actually works; a failed verification leaves the account
critical. The proposed password is read from the DPAPI vault — the UI passes
only the batch and account keys, never credentials.

## Checkpoint, Resume, Abandon, And Export

Account Keeper never auto-resumes a password-changing job when BrProxies
starts.

- **Resume** continues an incomplete non-critical job from the next queued
  account. A `waiting_manual` job can reopen its profile and continue after the
  operator completes the challenge.
- **Abandon** stops tracking the incomplete job but preserves account-to-profile
  mappings.
- **Export Result** writes the current result to a selected plaintext JSON
  path after explicit confirmation.
- Failed results can be inspected through redacted UI state without decrypting
  credentials into React.

## Profile Mapping And Local Data

Account identifiers are normalized and converted to stable account keys. A new
account receives a persistent profile with a masked display name such as
`acct-1a2b3c4d`; a later batch reuses the stored `profile_id`.

After a verified rotation (normal flow or **Verify & Resolve**), the profile is
relabeled: its visible name becomes the account (e.g. the email), and its Notes
field is set to the `account|password|totp_secret` line so operators can
identify and reuse the profile from the browser list. **Security note:** the
profile JSON is not encrypted, so this writes the plaintext credential line to
disk outside the DPAPI vault. This is intentional per operator request; treat
the profiles directory as secret-bearing, like the output JSON.

Windows data lives under:

```text
%APPDATA%\brproxies-launcher\account-keeper\
```

Important files:

- `vault.bin` contains account identifiers, the current known password,
  optional TOTP secret, profile mapping, password state, and status metadata.
  It is encrypted locally with Windows DPAPI.
- `jobs\<batch_id>.json` contains resumable job metadata such as profile IDs,
  states, attempts, timestamps, template, output path, and redacted errors. It
  does not contain plaintext passwords or TOTP secrets.
- The operator-selected output JSON is plaintext and may contain the account,
  usable password, and TOTP secret.

DPAPI protects the internal vault for the current Windows security context. It
does not protect the selected plaintext input or output files.

## Output JSON

Schema version 1:

```json
{
  "schema_version": 1,
  "batch_id": "batch-synthetic-001",
  "updated_at": "2026-07-29T00:00:00Z",
  "accounts": [
    {
      "account": "owner@example.test",
      "password": "synthetic-generated-password",
      "new_password": "synthetic-proposed-password",
      "password_state": "changed",
      "totp_secret": "JBSWY3DPEHPK3PXP",
      "profile_id": "profile-synthetic-001",
      "status": "success",
      "last_verified_at": "2026-07-29T00:00:00Z"
    }
  ]
}
```

Output rules:

- `password` is the last known usable password.
- `new_password` is the password Account Keeper attempted to switch to. It is
  present while a rotation is pending or critical (so an operator can see which
  new password was tried after a failed verification), and omitted once the
  rotation is verified and promoted into `password`.
- `password_state` is `original`, `changed`, or `unknown`.
- `status` is the current terminal or checkpointed account state.
- A known failed account retains the original password.
- A critical account uses `password_state: unknown` and stops the batch.
- `totp_secret`, `last_verified_at`, and `error` are omitted when unavailable.
- The file is updated atomically after each account by replacing the
  destination only after the new JSON is serialized successfully.
- Account Keeper does not create backup, diagnostic, or telemetry copies of
  this output.

Treat the output as a credential vault. Restrict access, move it to its final
secure location promptly, and securely remove obsolete plaintext copies.

## Troubleshooting

| Code or symptom | Meaning and action |
| --- | --- |
| `invalid_credentials` | The current direct-login credentials were rejected. Account Keeper does not retry. Verify the account and password outside the batch, then prepare a corrected input file. |
| `totp_rejected` | The submitted TOTP was rejected. Account Keeper can wait for the next 30-second window and retry once; a second rejection requires manual intervention. Check the Windows clock and the Base32 secret. |
| `waiting_manual` | CAPTCHA, email verification, unusual login, or another security challenge is visible. Use **Open Profile**, complete it manually, then choose **Continue** or **Mark Failed**. |
| `flow_changed` | The supported page structure or expected semantic state is no longer recognized. Stop; do not click by guess or visual proximity. Update the provider adapter before retrying. |
| `unsupported_login_method` | The account uses Google, Microsoft, Apple, or another unsupported login method. Direct email/password accounts only in the MVP. |
| `navigation_failed` | Repeated navigation or network failure. Check connectivity, proxy behavior, DNS, and provider availability. The coordinator may retry up to three times with bounded backoff. |
| `browser_crashed` or CDP failure | The browser closed or the CDP connection became unavailable. Account Keeper may restart the profile and worker once. If it repeats, stop other processes using the profile, verify the BrProxies runtime, and relaunch. |
| `worker_not_ready` or protocol failure | Worker files, adapter flow, or stdio protocol could not start. Rebuild the worker resources and inspect redacted logs. |
| `credential_state_unknown` | Critical recovery state after password submission may have started. The batch stops and the profile stays open. Determine the valid credential through the provider's official recovery flow before any new batch. |

Runtime-specific messages:

- `Account Keeper worker resources are missing; reinstall BrProxies`: release
  resources are absent or incomplete.
- `Account Keeper bundled Node runtime is missing`: bundled `node.exe` is
  missing.
- `Account Keeper bundled worker is missing`: the worker entry point is
  missing.
- `Account Keeper bundled Patchright dependency is missing` or the Patchright
  Core equivalent: bundled worker dependencies are incomplete.
- `Account Keeper debug mode requires Node.js on PATH`: install Node 18 or
  newer for the debug-only system-Node fallback, or prepare bundled resources.

## Developer Build

Prepare the Windows worker bundle from the repository root:

```powershell
npm.cmd run build:account-keeper-worker
```

The command:

- runs production dependency installation for `automation/` without a browser
  download;
- downloads the pinned Windows x64 Node archive described by
  `automation/node-runtime.json`;
- verifies the archive against the configured SHA-256 and the official Node
  checksum list;
- copies Node, the worker module graph, provider adapters, Patchright, and
  Patchright Core into `src-tauri/resources/account-keeper/`;
- writes and verifies `manifest.json`.

`src-tauri/tauri.windows.conf.json` runs the frontend build plus the worker
bundle command before a Windows Tauri build, then packages
`resources/account-keeper/` as the `account-keeper/` application resource.

In debug mode only, missing bundled resources fall back to the source worker
under `automation/` and system `node` on `PATH`. Do not rely on that fallback
when validating a release installer.

## Development-Only Synthetic Tauri QA

Install the isolated worker dependencies once, then run the full Windows QA
workflow from the repository root:

```powershell
npm.cmd ci --prefix automation --ignore-scripts
npm.cmd run qa:account-keeper-tauri
```

This command starts a loopback authentication fixture and the real Tauri debug
application. It uses only synthetic credentials and an isolated absolute config
root under `%TEMP%\BrProxies-AccountKeeper-QA`. The QA bridge is enabled only in
Vite development mode with `?account-keeper-qa=1`; release builds do not expose
it.

The workflow verifies Rust-generated RFC 6238 TOTP, manual challenge/Continue,
password change, logout and re-login, atomic output JSON, persistent profile
reuse, and explicit resume after a Tauri restart. It also confirms that the
normal BrProxies profile filenames remain unchanged. Cleanup removes the QA
root and stops its child processes. Never substitute a production account or
provider for this fixture.

## 9Router And Cockpit Import Boundary

The section 04 import payload is a local profile reference, not a session
export. Consumers may use the stable `profile_id`, redacted success metadata,
local API base URL, and opaque vault reference. Cookie export, browser-session
export, credential export, and token export remain outside this feature.
Provider OAuth or gateway-token support requires a separate design and
authorization review.
