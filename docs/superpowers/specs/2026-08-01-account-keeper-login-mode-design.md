# Account Keeper — "Login GPT" mode + in-project output

Date: 2026-08-01
Status: Approved design, pending implementation plan

## Problem

Two operator requests against the running Account Keeper UI:

1. **Login-only operation.** Today Account Keeper only rotates passwords
   (login → change password → verify). Operators also want a *login-only*
   flow: create the persistent profile, sign in with the imported
   credentials, and keep the authenticated session in the profile — without
   changing the password. This is for warming/storing an authenticated
   account, not rotating it.

2. **Output file location.** The default output path is under the Windows
   Documents directory (`%USERPROFILE%\Documents\account-keeper-result.json`),
   which operators have to hunt for. They want it inside the project
   (`./output/account-keeper-result.json`) so it is easy to find.

## Non-goals

- No change to the security invariants (path-only args, authorization gate,
  redaction, forbidden-field rejection, TOTP boundary, account masking).
- No new provider adapter; login-only reuses the existing
  `verify_credentials` operation already implemented in the flow driver.
- No protocol shape change and **no `PROTOCOL_VERSION` bump** — `operation`
  is already a field on `WorkerStart` and the flow already handles
  `verify_credentials`.

## Key existing facts

- `automation/account-keeper-flow.mjs` already branches on
  `request.operation`: `verify_credentials` runs `openLogin` → `authenticate`
  → `verifySignedIn` → emits `verified` (no password change, no
  `password_submit_required`). The default path runs the full rotation.
- Rust `WorkerStart` (`account_keeper.rs`) already carries
  `operation: String`. The coordinator hardcodes `"change_password"` at
  `account_keeper.rs:2598`; `resolve_critical`/verify uses
  `"verify_credentials"` at `account_keeper.rs:1714`.
- The managed-profile list (`account_keeper.rs:3346`) currently filters
  `password_state == Changed && last_status == "success"`.
- `default_config_for` (`account_keeper.rs:1060`) builds the output path from
  the Documents directory.
- `store::atomic_write_bytes` already `create_dir_all(parent)`, so writing to
  `./output/…` auto-creates the `output/` directory.
- `PasswordState`: `Original` (imported, unchanged), `Changed` (rotated +
  verified), `Unknown` (critical/uncertain).

## Design

### 1. Operation model

Add an `operation` concept to the batch, with two values:

- `change_password` (existing behavior; the default).
- `login` (new): sign in and persist the authenticated profile; do **not**
  rotate the password.

The Rust→worker mapping:

| Batch operation    | Worker `operation`     | Password generated? | Terminal success state         |
|--------------------|------------------------|---------------------|--------------------------------|
| `change_password`  | `change_password`      | yes                 | `PasswordState::Changed`       |
| `login`            | `verify_credentials`   | no                  | `PasswordState::Original`      |

Login-only never emits `password_submit_required` and never calls
`submitPasswordChange`, so the password-submit authorization gate does not
apply — nothing rotates.

### 2. Frontend (`src/account-keeper/`)

- **`types.ts` / `DraftState`**: add `operation: "login" | "change_password"`,
  default `change_password`.
- **`AccountKeeper.tsx`**: a two-button mode toggle at the top of the Batch
  setup panel, styled like the existing "Paste text / Choose file" toggle:
  `Change pass` | `Login GPT`.
  - In `login` mode, hide the **Template** and **Output file** fields.
  - The primary button label follows the mode: "Start Batch" for change,
    "Login & Save Profile" for login.
  - `startBatch` includes `operation` in the `account_keeper_start_batch`
    payload; in `login` mode it sends empty `template` and `outputPath`.
  - The plaintext-acknowledgement checkbox copy stays (input still contains
    plaintext secrets even in login mode).
- **`model.ts` / `canStart`**: gate by mode. `login` mode requires a valid
  input + plaintext ack, but NOT `templateValidation.valid` and NOT
  `outputPath`. `change_password` keeps all current requirements.
- **Profiles panel**: add a badge distinguishing `Logged in` (Original state)
  from `Rotated` (Changed state). Both remain in the single Profiles panel.
  This requires exposing the distinction in `ManagedProfileView` (see §3).

### 3. Rust backend (`src-tauri/src/account_keeper.rs`)

- **`StartRequest`**: add `operation: String` (still
  `#[serde(deny_unknown_fields)]`). Validate it equals `"login"` or
  `"change_password"`; reject anything else. For `login`, skip the
  template-parse and empty-output validation that `change_password` enforces.
- **Persist the operation** on the checkpoint so a resumed job keeps its
  operation. Add an `operation` field to `JobCheckpoint`
  (`account_keeper_store.rs`), defaulting to `"change_password"` for
  backward-compatible deserialization of existing checkpoints
  (`#[serde(default = …)]`).
- **Coordinator (`process_account` / `run_batch`)**:
  - Only generate a `pending_password` from the template when
    `operation == "change_password"`. For `login`, `new_password` is empty and
    no template is required.
  - Build `WorkerStart.operation` = `"verify_credentials"` for `login`, else
    `"change_password"`.
  - On worker `Verified` for a `login` job: mark the account
    `last_status = "success"`, `last_verified_at = now`, label the profile,
    but keep `password_state = Original` (no rotation). This needs a
    login-specific branch in `apply_worker_event` (or a variant) because the
    current `Verified` arm asserts `pending_password.is_some()` and sets
    `Changed` — that path is specific to rotation.
- **Managed-profile filter (`account_keeper.rs:3346`)**: broaden from
  `password_state == Changed && last_status == "success"` to
  `last_status == "success" && last_verified_at.is_some()`, so login-only
  (Original) profiles appear too. Add a field to `ManagedProfileView`
  indicating whether the password was rotated (`rotated: bool` =
  `password_state == Changed`) for the frontend badge.
- **`default_config_for`**: change the output path from the Documents
  directory to `<current_dir>/output/account-keeper-result.json`. Resolve
  `std::env::current_dir()` at defaults-load time and produce an absolute path
  for display. `atomic_write_bytes` auto-creates `output/`. Keep the
  non-Unicode-path guard.
  - **Caveat:** `current_dir()` equals the project root under
    `npm run tauri dev` (the operator's workflow), but for a packaged `.msi`
    install it is the install/launch directory, not a source tree. That is
    acceptable — the value is only a prefilled default the operator can edit,
    and it is always shown as an absolute path. Fall back to the Documents
    directory only if `current_dir()` fails.

### 4. Worker / protocol

No changes. Login-only reuses `verify_credentials`, which the flow driver
already implements. `PROTOCOL_VERSION` unchanged.

### 5. Security review

- Path-only args: unchanged. `operation` is an enum string, not a credential.
- Authorization gate: `change_password` still requires
  `authorize_password_change: true`. `login` does not rotate, so it never
  reaches password submission — no weakening of the rotation gate.
- Redaction / forbidden fields / TOTP boundary / masking: untouched.
- Login-only still labels the profile with the plaintext credential line into
  unencrypted profile JSON — same operator-accepted tradeoff already applied at
  import time. No new exposure.

Run the `brproxies-security-auditor` agent after implementation.

## Testing

- **Rust** (`cargo test`):
  - `StartRequest` rejects an unknown `operation` value; accepts `login` and
    `change_password`.
  - `login` job with no template/output validates and starts.
  - Worker `Verified` on a `login` job → account becomes a managed profile with
    `PasswordState::Original`, `last_status == "success"`, `rotated == false`.
  - `default_config_for` yields `<cwd>/output/account-keeper-result.json`.
  - `JobCheckpoint` without `operation` deserializes as `change_password`.
- **Frontend** (`vitest`, `model.test.ts`):
  - `canStart` in `login` mode passes without template/output; in
    `change_password` mode still requires them.
- **Automation** (`node --test`): existing `verify_credentials` flow test
  covers the login path; add a login-keep-profile assertion if a gap remains.

## Rollout

Single release. Bump to v1.0.7 after implementation, matching the existing
release cadence. Keep bundle worker in sync (`npm run
build:account-keeper-worker`) — though no worker source changes here, the
version stamp in the bundle updates.
