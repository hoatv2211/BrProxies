---
name: account-keeper
description: "Use when working on BrProxies Account Keeper or authorized ChatGPT/OpenAI account automation: signed-in settings navigation, password verification, authenticator 2FA rotation, TOTP/identity challenges, dynamic CDP recovery, stale worker bundles, vault/Notes/output reconciliation, resume/critical recovery, provider adapters, or secret-safe live testing."
---

# Account Keeper

Use this skill for Account Keeper work inside BrProxies. Preserve credentials, persistent profiles, and the password-state safety model while fixing the smallest root cause.

Last updated: **2026-08-19**.

## Start Here

1. Read `references/architecture.md` for ownership and data flow.
2. Read only the relevant section of `references/debugging.md`.
3. Read `references/live-account-safety.md` before touching a real account or `account-keeper-result.json`.
4. Read `references/chatgpt-2fa.md` for ChatGPT authenticator rotation, stuck MFA challenges, or live TOTP recovery.
5. Use focused commands from `references/commands.md`.
6. Read `references/operator-workflow.md` when the operator wants to supply `account|current_password|totp_secret` and receive an output file.
7. Use `references/extension-guide.md` when adding a provider, state, protocol message, or workflow.

## Operator Workflow Contract

- Accept a local input-file path containing `account|current_password|totp_secret`; do not ask the operator to paste live credentials into chat.
- Run one live account at a time unless the operator explicitly requests a batch.
- Use the Account Keeper coordinator and persistent mapped profile; do not replace it with ad-hoc browser automation.
- If the profile is already signed in, open password settings directly and continue through any current-password identity challenge.
- For `change_totp`, preserve the signed-in session from disabling the old factor through enrolling and verifying the new factor.
- Write the result through the normal atomic vault/checkpoint/output transaction.
- Report only verified outcome metadata. See `references/operator-workflow.md` for the complete reusable runbook.

## Non-Negotiable Behavior

- Treat `account-keeper-result.json`, input records, the vault, TOTP secrets, cookies, and browser sessions as secrets.
- Never print or paste account identifiers, passwords, TOTP secrets, cookies, tokens, or full secret-bearing JSON into chat, logs, tests, docs, screenshots, commits, or diffs.
- Use only accounts owned by the operator or explicitly authorized for management.
- Never automate CAPTCHA, inbox access, email-link extraction, device approval, or security-control bypass.
- Preserve one persistent BrProxies profile per normalized account.
- Stop the batch on `credential_state_unknown`; keep the affected profile available for manual recovery.
- Do not mark a password `changed` or an account `success` until a new-password sign-in is verified.
- Do not mark a TOTP rotation `success` until the provider accepts a code from the new enrollment and the authenticator setting is visibly enabled.
- Do not start a second blind rotation when browser state and persistence disagree; inspect and reconcile the active session first.
- Update secret-bearing output atomically. Never create debug or backup copies containing credentials.

## Login And Password-Change Contract

- First classify the current page and authentication state.
- If the mapped profile is already signed in, skip credential submission and navigate directly to password settings.
- For ChatGPT/OpenAI, use the signed-in route: profile menu, **Settings**, **Security and login**, **Password**.
- Do not log out or start **Forgot Password** before attempting the signed-in password-change flow.
- If the profile is signed out, use direct email/password login, then navigate to password settings.
- After password submission, log out only for verification, sign in with the proposed password, then emit `verified`.
- After verification, persist `password_state: changed`, `status: success`, the verified password, and `last_verified_at` to the vault/checkpoint/output transaction.

## ChatGPT 2FA Contract

- Execute one uninterrupted sequence: inspect current state, disable the old authenticator, satisfy identity/TOTP challenges in the provider's actual order, confirm removal, enroll the new authenticator, submit a code generated from the new secret, and verify the setting is enabled.
- Treat `confirmation -> identity -> TOTP` and `identity -> TOTP -> confirmation` as valid provider orderings.
- Reacquire the active allowed-origin page between phases; ChatGPT settings remain in the app page while identity and MFA challenges may use `auth.openai.com`.
- Send the old stored TOTP only for a visible old-factor challenge. Generate the enrollment code only from the newly emitted enrollment secret.
- Keep the profile open on any uncertain state. A failure after disable authorization is security-critical until live inspection proves which factor is active.
- After verification, converge browser truth, encrypted vault, profile Notes, checkpoint, and output before reporting success. See `references/chatgpt-2fa.md`.

## Debugging Workflow

1. Reproduce with the smallest synthetic test or fixture.
2. Trace the flow from Rust coordinator request through worker protocol, `account-keeper-flow.mjs`, and the provider adapter.
3. Identify the first wrong state transition or browser side effect.
4. Add or tighten a failing test before implementation when practical.
5. Patch the narrowest owner file; avoid unrelated refactors.
6. Run focused Node or Rust tests, then broader Account Keeper validation.
7. Use a real authorized account only when synthetic coverage passes and live verification is required.
8. Inspect only redacted metadata from the output: terminal `status`, `password_state`, and presence of `last_verified_at`.

## Source Ownership

- React UI and input model: `src/account-keeper/`.
- Rust coordinator and state machine: `src-tauri/src/account_keeper.rs`.
- Vault, checkpoint, job, event, and output persistence: `src-tauri/src/account_keeper_store.rs`.
- Worker resolution, packaging, protocol redaction: `src-tauri/src/account_keeper_worker.rs`.
- Browser orchestration: `automation/account-keeper-flow.mjs`.
- ChatGPT/OpenAI page contract: `automation/adapters/openai-chatgpt-v1.mjs`.
- Worker protocol: `automation/account-keeper-protocol.mjs`.
- Worker runtime and entry point: `automation/account-keeper-worker-runtime.mjs`, `automation/account-keeper-worker.mjs`.
- Worker resource packaging: `scripts/prepare-account-keeper-worker.mjs`.
- User and developer docs: `docs/account-keeper.md`, `docs/account-keeper.vn.md`.

## Completion Gate

Do not report success without evidence:

- Relevant automated tests pass.
- Worker bundle builds when worker resources or dependencies changed.
- No credential values appear in `git diff`, test fixtures, logs, or newly created files.
- Password-change runs reach verified new-password login and output `status: success`, `password_state: changed`, with fresh `last_verified_at`.
- TOTP-change runs keep the account signed in, prove the new code is accepted, leave authenticator 2FA enabled, and output `status: success` with fresh `last_verified_at`.
- Vault, profile Notes, checkpoint, and output agree on the verified secret without exposing it.
