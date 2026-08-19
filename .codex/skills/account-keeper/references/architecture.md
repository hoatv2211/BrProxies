# Architecture

## End-To-End Flow

1. React validates pasted or file input and starts a batch through Tauri commands.
2. Rust normalizes accounts, maps persistent profiles, creates the encrypted vault and public checkpoint, then launches one account at a time.
3. Rust launches the mapped BrProxies profile with CDP and starts a fresh Node worker.
4. The worker connects through CDP and delegates browser semantics to the provider adapter.
5. Protocol events return stages, TOTP requests, manual-intervention requests, password-submission boundaries, verification, or canonical failure codes.
6. Rust updates vault, checkpoint, events, and output according to the password-state safety rules.

## Ownership Map

| Area | Primary files | Responsibility |
| --- | --- | --- |
| UI | `src/account-keeper/AccountKeeper.tsx`, `model.ts`, `types.ts` | Input modes, validation, controls, progress, resume, export |
| Coordinator | `src-tauri/src/account_keeper.rs` | Batch lifecycle, profile mapping, worker commands, TOTP, resume, cancellation |
| Persistence | `src-tauri/src/account_keeper_store.rs` | DPAPI vault, checkpoint, job/event files, atomic output JSON |
| Worker bridge | `src-tauri/src/account_keeper_worker.rs` | Resource discovery, embedded worker, line redaction, failure messages |
| Browser flow | `automation/account-keeper-flow.mjs` | Authentication, password change, logout/re-login verification |
| Provider adapter | `automation/adapters/openai-chatgpt-v1.mjs` | Locators, page classification, navigation, submissions |
| Protocol | `automation/account-keeper-protocol.mjs` | Message schemas, stages, sanitization |
| Packaging | `scripts/prepare-account-keeper-worker.mjs` | Node runtime, Patchright, module graph, manifest |

## ChatGPT 2FA Ownership

- `account-keeper-flow.mjs` owns old-factor removal, challenge resolution, enrollment, and new-code verification.
- `openai-chatgpt-v1.mjs` owns ChatGPT settings, localized controls, popup/page adoption, toggle state, enrollment DOM, and challenge classification.
- Rust owns both TOTP code paths: the stored secret serves only a visible old-factor challenge; the pending new secret serves only enrollment verification.
- `TotpDisableRequired` is the irreversible boundary. Failures after authorization remain critical until the active factor is proven.
- A verified TOTP commit must converge browser state, encrypted vault, profile Notes, checkpoint, and output.

## Persistence Model

- `vault.bin` is secret-bearing and DPAPI-protected for the current Windows context.
- Checkpoint, job, and event data must remain redacted.
- Output JSON is plaintext and secret-bearing. It contains the last known usable password and may contain the TOTP secret.
- Output schema version 1 uses root fields `schema_version`, `batch_id`, `updated_at`, and `accounts`.
- Account output fields include `account`, `password`, `password_state`, `profile_id`, `status`, and optional `totp_secret`, `last_verified_at`, or `error`.
- Write output atomically after safe state transitions; do not partially overwrite the destination.

## Password-State Invariants

- Before password submission: `password_state: original`.
- After verified new-password login: `password_state: changed`, `status: success`.
- If submission may have occurred but verification cannot determine the valid credential: `password_state: unknown`, `status: critical`.
- A known failure before submission retains the original password.
- A critical account stops the entire batch and keeps the mapped profile open.

## Worker Resource Model

- Release builds use bundled Windows Node, worker modules, Patchright, and Patchright Core under `src-tauri/resources/account-keeper/`.
- Debug builds may fall back to source modules under `automation/` and system Node 18+.
- Never validate release readiness using only the debug fallback.
- A copied `src-tauri/target/debug/account-keeper/` bundle can remain stale after source edits. Rebuild resources and verify hashes against both resource and debug worker copies before live testing.
