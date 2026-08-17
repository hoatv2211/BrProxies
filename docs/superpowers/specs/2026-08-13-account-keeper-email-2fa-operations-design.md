# Account Keeper: Change Email and Change 2FA

**Date:** 2026-08-13
**Status:** Proposed for operator review

## Goal

Add `Change 2FA` and `Change email` beside the existing `Change pass` and
`Login GPT` operations. Preserve one persistent BrProxies profile per account and
keep all credential mutations conservative and recoverable.

## Input and UI

```text
Change pass / Login GPT / Change 2FA:
account|current_password|totp_secret

Change email:
current_email|current_password|totp_secret|new_email
```

`new_email` is required, normalized separately, and must differ from the current
email. Both new operations require a plaintext output path and the existing secret
acknowledgement. Worker operation values are `change_password`,
`verify_credentials`, `change_totp`, and `change_email`.

## Change 2FA

1. Authenticate with the current email, password, and TOTP when required.
2. Open the provider authenticator settings and replace the enrollment.
3. CAPTCHA, device approval, and unsupported security challenges enter
   `waiting_manual`; they are never bypassed.
4. Send the new enrollment secret only through a strict secret-bearing worker
   message to Rust. Never place it in logs, checkpoints, or progress events.
5. Rust generates the confirmation code and sends only that short-lived code back.
6. Verify that authenticator 2FA is enabled before atomically replacing the stored
   TOTP secret and setting `totp_state: changed`.

If the old factor may have been disabled but the new factor cannot be verified,
set `totp_state: unknown`, mark the account `critical`, stop the batch, and keep the
profile open.

## Change Email

1. Authenticate and submit `new_email` through the provider settings UI.
2. Handle current-password and current-TOTP prompts with existing mechanisms.
3. Request one verification artifact from a locally configured mailbox connector,
   scoped to the exact job, recipient, provider, and request time.
4. Prefer a code. If only a link exists, accept one HTTPS URL whose origin matches
   a configured provider allowlist and open it in the mapped profile.
5. The connector exposes no mailbox listing or arbitrary message-reading API to
   the worker. It returns only one filtered, single-use artifact.
6. Missing, ambiguous, or failed connector results enter `waiting_manual`; the
   profile remains open and the operator presses `Continue` after verification.
7. Verify that the signed-in account reports the new email. When supported, log out
   and sign in with the new email and current password.
8. Only after verification, atomically update the account identifier, output, and
   persistent-profile mapping metadata.

The connector uses an operator-configured local API/MCP integration. Its endpoint,
mailbox ID, allowlist, polling settings, and authentication material live in local
protected settings. Account Keeper does not perform browser-based mailbox login.

## Connector Boundary

```text
MailboxConnector.fetch_verification(job_context) ->
  Code(value) | Url(value) | Pending | Ambiguous | Failed
```

The UI offers `Auto via mailbox connector` when configured and `Manual
verification`. Auto mode falls back to manual unless exactly one valid artifact is
returned.

## Persistence and States

Output schema advances to version 2 while version-1 vaults/checkpoints remain
readable with defaults.

```text
totp_state: original | pending | changed | unknown
email_state: original | pending | changed | unknown
```

Password state remains independent. For email changes, the protected vault keeps
an internal alias from the previous normalized account key to the new key so the
same profile is reused. Public progress never reveals both addresses.

New stages:

```text
changing_totp
verifying_new_totp
changing_email
waiting_email_verification
verifying_new_email
```

New strict protocol messages cover the enrollment secret/code, completed 2FA
change, submitted email change, verification requirement, verification code/URL,
and completed email change. Unknown fields are rejected and secret-bearing lines
are redacted.

## Failure Rules

- Failure before provider mutation retains the original state.
- An accepted but unverified mutation becomes `unknown` and `critical` when the old
  email/factor may no longer work.
- Mailbox timeout alone becomes `waiting_manual`, not `critical`.
- Cancellation after a possible mutation uses the same conservative unknown-state
  rule as password rotation.
- Resume first reclassifies the visible provider page before another side effect.

## Verification

Implementation is test-first across React operation controls and validation, Rust
input parsing/state/store migration, strict Node protocol redaction, provider flow
fixtures, connector code/link/manual fallback, resume behavior, and critical-state
recovery. Final validation includes Node, React, Rust, worker bundle, synthetic
Tauri QA, `git diff --check`, and a secret scan using reserved synthetic values.

## Expected Owners

- `src/account-keeper/`
- `src-tauri/src/account_keeper_format.rs`
- `src-tauri/src/account_keeper.rs`
- `src-tauri/src/account_keeper_store.rs`
- `src-tauri/src/account_keeper_worker.rs`
- New narrow Rust mailbox connector and protected settings fields
- `automation/account-keeper-protocol.mjs`
- `automation/account-keeper-flow.mjs`
- `automation/adapters/openai-chatgpt-v1.mjs`
- Account Keeper tests, worker packaging, and English/Vietnamese docs

## Out of Scope

Generic mailbox browsing/export, browser mailbox login, CAPTCHA solving, device
approval automation, recovery of a pre-existing unknown state, social-login email
changes, and parallel account mutation.
