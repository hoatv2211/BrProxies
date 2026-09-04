# Account Keeper Email and 2FA Operations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add safe `Change 2FA` and `Change email` Account Keeper operations with strict persistence, protocol redaction, provider automation, and mailbox/manual email verification.

**Architecture:** Extend the existing operation-aware batch model rather than creating a second coordinator. Rust remains the owner of secrets and atomic state; Node owns browser semantics; a narrow Rust HTTP mailbox connector returns only a scoped code or approved URL and otherwise falls back to the existing manual-resume path.

**Tech Stack:** React/TypeScript/Vitest, Tauri/Rust/Tokio/Reqwest, Node.js/Patchright/node:test.

---

### Task 1: Operation-aware input and UI

**Files:** `src/account-keeper/types.ts`, `src/account-keeper/model.ts`, `src/account-keeper/model.test.ts`, `src/account-keeper/AccountKeeper.tsx`, `src/account-keeper/AccountKeeper.test.tsx`, `src/account-keeper/AccountKeeper.css`

- [ ] Add failing tests for four operation buttons, output requirements, four-field email input guidance, mailbox mode, start payloads, and new stage labels.
- [ ] Run focused frontend tests and confirm the new assertions fail because the operations do not exist.
- [ ] Add operation types, state, labels, conditional fields, validation arguments, and payload mapping with no unrelated UI refactor.
- [ ] Run focused frontend tests until green.

### Task 2: Rust parsing and persisted states

**Files:** `src-tauri/src/account_keeper_format.rs`, `src-tauri/src/account_keeper_store.rs`, `src-tauri/src/account_keeper.rs`

- [ ] Add failing Rust tests for `change_email` four-field parsing, normalized/different new email, `change_totp`, new stages/events, schema migration defaults, and unknown-state cancellation.
- [ ] Run focused Rust tests and confirm expected failures.
- [ ] Add an operation enum, optional `new_email`, email/TOTP state enums, new stages/transitions, and backward-compatible serde defaults.
- [ ] Keep password-state semantics unchanged and update output atomically only after the relevant verified event.
- [ ] Run focused Rust tests until green.

### Task 3: Mailbox connector boundary

**Files:** `src-tauri/src/account_keeper_mailbox.rs`, `src-tauri/src/settings.rs`, `src-tauri/src/lib.rs`, `src-tauri/src/account_keeper.rs`

- [ ] Add failing tests for disabled connector, scoped code response, allowed HTTPS URL, rejected origin, ambiguity, timeout, and redacted errors.
- [ ] Run focused Rust tests and confirm the connector is missing.
- [ ] Implement an optional local HTTP connector using protected settings, bounded polling, exact response schema, recipient/job/provider scoping, and URL-origin allowlisting.
- [ ] Return manual fallback for pending/ambiguous/failure without exposing mailbox contents or credentials.
- [ ] Run connector and coordinator tests until green.

### Task 4: Strict worker protocol

**Files:** `automation/account-keeper-protocol.mjs`, `automation/account-keeper-worker-runtime.mjs`, `automation/tests/account-keeper-protocol.test.mjs`, `automation/tests/account-keeper-worker.test.mjs`, `src-tauri/src/account_keeper_worker.rs`

- [ ] Add failing Node/Rust tests for new operations, operation-specific request fields, enrollment secret/code, email artifact commands, and strict redaction.
- [ ] Run focused protocol tests and confirm failures.
- [ ] Add exact schemas and command routing; reject unknown fields and redact all secret-bearing values.
- [ ] Run focused Node/Rust protocol tests until green.

### Task 5: Browser flows and OpenAI adapter

**Files:** `automation/account-keeper-flow.mjs`, `automation/adapters/openai-chatgpt-v1.mjs`, `automation/adapters/fixture-v1.mjs`, `automation/tests/account-keeper-flow.test.mjs`, `automation/tests/account-keeper-fixture-e2e.test.mjs`

- [ ] Add failing synthetic tests for signed-in/signed-out 2FA rotation, current-factor challenge, enrollment verification, email code/link verification, post-change sign-in, and manual resume.
- [ ] Run focused flow tests and confirm failures.
- [ ] Add operation dispatch and provider methods using role/accessibility locators for current Settings → Account email and Settings → Security MFA surfaces.
- [ ] Set irreversible mutation boundaries before submit and emit verified events only after provider confirmation.
- [ ] Run focused and full automation tests until green.

### Task 6: Coordinator integration and output

**Files:** `src-tauri/src/account_keeper.rs`, `src-tauri/src/account_keeper_store.rs`, `src/account-keeper/types.ts`, `src/account-keeper/model.ts`

- [ ] Add failing integration tests for worker request construction, connector command delivery, profile alias preservation, v2 output, resume, critical stop, and masked views.
- [ ] Run focused tests and confirm failures.
- [ ] Wire operation-specific coordinator behavior, TOTP generation from proposed secret, mailbox polling, manual fallback, and verified atomic updates.
- [ ] Run Rust and frontend integration tests until green.

### Task 7: Packaging and documentation

**Files:** `scripts/prepare-account-keeper-worker.mjs`, `docs/account-keeper.md`, `docs/account-keeper.vn.md`, `.codex/skills/account-keeper/references/architecture.md`, `.codex/skills/account-keeper/references/debugging.md`

- [ ] Update worker resource expectations and operator documentation with synthetic input/output only.
- [ ] Document connector contract, manual fallback, eligibility limitations, and recovery rules.
- [ ] Build the Account Keeper worker bundle.

### Task 8: Final verification

- [ ] Run focused frontend, Node, and Rust Account Keeper tests.
- [ ] Run `npm.cmd run build` and `npm.cmd run build:account-keeper-worker`.
- [ ] Run broader Account Keeper validation and synthetic Tauri QA where the local environment supports it.
- [ ] Run `git diff --check`, inspect `git status --short`, and scan the diff for credentials, TOTP values, mailbox tokens, verification artifacts, or non-synthetic account identifiers.
