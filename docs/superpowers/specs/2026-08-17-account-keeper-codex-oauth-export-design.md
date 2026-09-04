# Account Keeper: Codex OAuth Export For 9Router And Cockpit

**Date:** 2026-08-17
**Status:** Approved for implementation

## Goal

Authorize Codex OAuth inside each successful Account Keeper browser profile and
export real account credentials in JSON that can be pasted directly into 9Router
or Cockpit. This replaces the current metadata-only profile reference.

## Confirmed Formats

The supplied 9Router backup and Cockpit import contain the same credentials with a
one-to-one field mapping.

### 9Router

Export an array, including for one selected profile:

```json
[
  {
    "accessToken": "<token>",
    "refreshToken": "<token>",
    "idToken": "<token>",
    "expiresIn": 864000,
    "expiresAt": "<ISO timestamp>",
    "lastRefreshAt": "<ISO timestamp>",
    "email": "<email>",
    "name": "<email>",
    "providerSpecificData": {
      "chatgptAccountId": "<account id>",
      "chatgptPlanType": "<optional plan>"
    },
    "testStatus": "active",
    "isActive": true
  }
]
```

Do not export database-controlled connection IDs, priority, usage counters, model
locks, or a full 9Router backup. A full restore could overwrite unrelated settings,
API keys, providers, combos, and aliases.

### Cockpit

Export the supplied snake_case shape:

```json
[
  {
    "type": "codex",
    "id_token": "<token>",
    "access_token": "<token>",
    "refresh_token": "<token>",
    "account_id": "<account id>",
    "last_refresh": "<ISO timestamp>",
    "email": "<email>",
    "expired": "<ISO timestamp>",
    "account_note": "<email>"
  }
]
```

## OAuth Flow

1. The operator presses `Connect Codex` for a verified managed profile.
2. Rust loads the account from the encrypted vault and starts its persistent
   BrProxies profile with CDP.
3. Rust creates fresh OAuth state and PKCE values, binds the exact loopback
   callback, and builds the Codex authorization URL.
4. A narrow worker action opens only that allowlisted URL in the mapped profile.
   The worker never receives or emits OAuth tokens.
5. Visible confirmation or reauthentication remains operator-controlled; CAPTCHA
   and device approval are never bypassed.
6. Rust accepts only the expected callback and matching state, exchanges the code
   over HTTPS, and obtains access, refresh, and ID tokens.
7. Rust requires the token email to match the vault account and extracts the
   ChatGPT account ID and optional plan type.
8. Valid credentials are atomically persisted in the encrypted vault. Public job
   data, worker output, React state, and logs contain no token.

Authorization codes, callback query strings, token response bodies, and sensitive
URLs are redacted from every error and log.

## Persistence And Refresh

`VaultAccount` gains an optional protected Codex credential record containing the
tokens, account ID, optional plan, refresh/expiry timestamps, and lifetime. A serde
default keeps existing version-1 vaults readable.

Before export, Rust refreshes credentials when expiry is five minutes away or
closer. Refresh failure marks the profile `Reconnect required`; stale credentials
are never exported. Deleting the profile also deletes its Codex credentials.

## UI And Commands

Replace `Import Info` with `Connect Codex`, `Reconnect Codex`, or `Export`, based
on credential readiness. The panel only shows masked account and safe expiry data.

Actions:

- `Copy 9Router JSON`
- `Save 9Router JSON`
- `Copy Cockpit JSON`
- `Save Cockpit JSON`
- section-level `Export ready accounts` for bulk arrays

JSON creation, clipboard writes, refresh, and file writes happen in Rust. React
receives only safe counts and timestamps. Plaintext file export requires the
existing secret-output acknowledgement.

## Failure Rules

- Only verified successful profiles may authorize Codex.
- Account mismatch rejects the token without changing the vault.
- State mismatch, timeout, denied consent, malformed response, or unexpected issuer
  returns `codex_oauth_failed` without sensitive detail.
- Refresh failure returns `codex_reconnect_required` and produces no export.
- Failed replacement preserves the previous valid credential.
- OAuth runs one profile at a time; bulk export includes ready accounts only.

## Test Strategy

Implementation is test-first using synthetic JWTs and a local mock OAuth issuer.
Rust tests cover OAuth validation/exchange, claim mapping, vault compatibility,
refresh-before-export, exact JSON snapshots, bulk counts, and secret-free public
views. Frontend tests cover action states and backend-only copy/save commands.
Worker tests prove the OAuth URL allowlist and secret-free messages.

Final verification runs focused React, Rust, and worker tests, worker packaging,
the production build, `git diff --check`, and a synthetic-secret scan.

## Expected Owners

- `src/account-keeper/`
- `src-tauri/src/account_keeper.rs`
- `src-tauri/src/account_keeper_store.rs`
- a narrow Rust Codex OAuth/export helper
- `src-tauri/src/lib.rs`
- Account Keeper worker/protocol modules and tests
- Account Keeper English and Vietnamese documentation

## Out Of Scope

Importing credentials into BrProxies, cookie export, reading global Codex CLI
`auth.json`, invoking an external Codex CLI, full 9Router backups, remote token
delivery, parallel OAuth login, CAPTCHA solving, device-approval automation, and
exports for failed or unverified profiles.
