# Account Keeper Codex OAuth Export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Acquire refreshable Codex OAuth credentials inside managed BrProxies profiles and export directly importable 9Router or Cockpit JSON without exposing tokens to React, logs, or public progress data.

**Architecture:** A new Rust helper owns PKCE, callback validation, token exchange/refresh, claim parsing, and JSON formatting. Account Keeper persists credentials only inside its DPAPI vault; the existing Node worker gains one secret-free operation that opens an allowlisted authorization URL in the mapped CDP profile. Tauri commands copy or save generated JSON entirely in Rust, while React receives only redacted readiness and result metadata.

**Tech Stack:** Rust/Tauri 2, Tokio, Axum, Reqwest, Serde, SHA-256/Base64 PKCE, DPAPI vault, React 19/TypeScript, Vitest, Node 18 test runner, Patchright CDP worker.

---

## File Structure

- Create `src-tauri/src/account_keeper_codex.rs`: OAuth config, PKCE, callback parsing, token exchange/refresh, JWT claim extraction, expiry policy, and 9Router/Cockpit serializers.
- Modify `src-tauri/src/account_keeper_store.rs`: optional protected `CodexOAuthCredential` on `VaultAccount` with backward-compatible serde defaults.
- Modify `src-tauri/src/account_keeper.rs`: safe public readiness fields, connect/copy/save commands, worker OAuth operation, profile/runtime coordination, and tests with fake transports.
- Modify `src-tauri/src/lib.rs`: module declaration and Tauri command registration.
- Modify `src-tauri/Cargo.toml`: direct `chrono` dependency for RFC3339 timestamps.
- Modify `automation/account-keeper-protocol.mjs`: strict `codex_oauth` start request and `oauth_opened` response.
- Modify `automation/account-keeper-worker.mjs`: open the allowlisted authorization URL and emit only `oauth_opened`.
- Modify `automation/account-keeper-worker-runtime.mjs`: exact Codex OAuth URL validator.
- Modify worker tests under `automation/tests/`.
- Modify `src/account-keeper/types.ts`, `model.ts`, `AccountKeeper.tsx`, CSS, and React tests for readiness/actions with no token-shaped state.
- Modify `docs/account-keeper.md` and `docs/account-keeper.vn.md` to replace the old metadata-only boundary.

### Task 1: Protected Credential Model And Export Snapshots

**Files:**
- Create: `src-tauri/src/account_keeper_codex.rs`
- Modify: `src-tauri/src/account_keeper_store.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/Cargo.toml`
- Test: `src-tauri/src/account_keeper_codex.rs`
- Test: `src-tauri/src/account_keeper_store.rs`

- [ ] **Step 1: Write failing vault compatibility and formatter tests**

Add synthetic tests proving an old vault without `codex_oauth` deserializes with
`None`, a new vault round-trips credentials, and serializers match these keys:

```rust
#[test]
fn formats_exact_consumer_shapes() {
    let credential = synthetic_codex_credential();
    let nine = nine_router_accounts(&[("owner@example.test", &credential)]);
    assert_eq!(nine[0]["accessToken"], "synthetic-access");
    assert!(nine[0].get("id").is_none());

    let cockpit = cockpit_accounts(&[("owner@example.test", &credential)]);
    assert_eq!(cockpit[0]["type"], "codex");
    assert_eq!(cockpit[0]["account_note"], "owner@example.test");
}
```

- [ ] **Step 2: Run focused Rust tests and verify RED**

Run:

```powershell
Push-Location src-tauri
cargo test account_keeper_codex --lib
Pop-Location
```

Expected: compilation/test failure because the credential type and serializers do not exist.

- [ ] **Step 3: Implement the protected model and pure serializers**

Add this persisted shape with `#[serde(default, skip_serializing_if = "Option::is_none")]` on the vault field:

```rust
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CodexOAuthCredential {
    pub access_token: String,
    pub refresh_token: String,
    pub id_token: String,
    pub account_id: String,
    pub plan_type: Option<String>,
    pub last_refresh_at: String,
    pub expires_at: String,
    pub expires_in: u64,
}
```

Implement `nine_router_accounts` and `cockpit_accounts` as pure functions returning
`Vec<serde_json::Value>`. Add `chrono = { version = "0.4", features = ["clock", "serde"] }`.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run the Task 1 command and require all new tests to pass.

### Task 2: PKCE, Callback, Claims, And Refresh Client

**Files:**
- Modify: `src-tauri/src/account_keeper_codex.rs`
- Test: `src-tauri/src/account_keeper_codex.rs`

- [ ] **Step 1: Write failing OAuth unit tests**

Cover state mismatch, OAuth error callbacks, PKCE challenge derivation, sensitive
URL redaction, token email/account extraction, expiry threshold, authorization-code
exchange, and refresh against a loopback mock endpoint.

```rust
#[test]
fn rejects_callback_state_mismatch() {
    let error = parse_callback("code=synthetic&state=wrong", "expected").unwrap_err();
    assert_eq!(safe_codex_error(&error), "codex_oauth_failed");
}

#[test]
fn refreshes_within_five_minutes() {
    assert!(needs_refresh("2026-08-17T03:04:00Z", "2026-08-17T03:00:00Z"));
}
```

- [ ] **Step 2: Run focused tests and verify RED**

Run `cargo test account_keeper_codex --lib` from `src-tauri` and confirm failures name the missing OAuth helpers.

- [ ] **Step 3: Implement minimal OAuth helper**

Implement production defaults and injectable test config:

```rust
pub struct CodexOAuthConfig {
    pub issuer: Url,
    pub client_id: String,
    pub callback_ports: Vec<u16>,
}

pub struct PendingCodexOAuth {
    pub state: String,
    pub verifier: String,
    pub authorize_url: Url,
    pub redirect_uri: Url,
}
```

Use 32 random bytes for state and verifier entropy, SHA-256/S256 PKCE, exact
`/oauth/authorize` and `/oauth/token` paths, callback state validation, HTTPS for
production issuer, and canonical errors that never include response bodies or query values.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run `cargo test account_keeper_codex --lib` and require deterministic passes.

### Task 3: Secret-Free Worker OAuth Navigation

**Files:**
- Modify: `automation/account-keeper-protocol.mjs`
- Modify: `automation/account-keeper-worker-runtime.mjs`
- Modify: `automation/account-keeper-worker.mjs`
- Test: `automation/tests/account-keeper-protocol.test.mjs`
- Test: `automation/tests/account-keeper-worker.test.mjs`

- [ ] **Step 1: Write failing protocol and URL tests**

```javascript
test("accepts only exact Codex OAuth authorization URLs", () => {
  assert.equal(
    validateCodexOAuthUrl(validAuthorizeUrl).origin,
    "https://auth.openai.com",
  );
  assert.throws(() => validateCodexOAuthUrl("https://example.test/oauth/authorize"));
});

test("codex_oauth start contains no account credential", () => {
  const message = parseInbound(JSON.stringify(codexOauthStart));
  assert.equal(message.operation, "codex_oauth");
  assert.equal("account" in message, false);
});
```

- [ ] **Step 2: Run Node tests and verify RED**

Run:

```powershell
node --test automation/tests/account-keeper-protocol.test.mjs automation/tests/account-keeper-worker.test.mjs
```

- [ ] **Step 3: Implement the narrow operation**

Add `codex_oauth` to allowed operations. For this operation require only
`adapter_id`, `cdp_endpoint`, and `oauth_url`; reject account/password/new-password
fields. Add outbound `oauth_opened`. In the worker, connect to the sole CDP context,
create a page, validate and navigate to the URL, emit `oauth_opened`, and exit.

- [ ] **Step 4: Run Node tests and verify GREEN**

Run the Task 3 command and the complete `Push-Location automation; npm.cmd test; Pop-Location` suite.

### Task 4: Coordinator Connect, Refresh, Copy, And Save Commands

**Files:**
- Modify: `src-tauri/src/account_keeper.rs`
- Modify: `src-tauri/src/lib.rs`
- Test: `src-tauri/src/account_keeper.rs`

- [ ] **Step 1: Write failing coordinator tests with fakes**

Add tests for: only successful profiles connect; worker receives no account/password;
token email mismatch preserves the prior credential; ready/expired public states;
copy/save include ready profiles only; refresh occurs before export; stale export is rejected.

```rust
#[tokio::test]
async fn connect_codex_persists_only_matching_account() {
    let result = connect_codex_with(&runtime, &worker, &oauth, request).await.unwrap();
    assert_eq!(result.status, "ready");
    assert_eq!(worker.starts()[0].account, "");
    assert_eq!(worker.starts()[0].current_password, "");
}
```

- [ ] **Step 2: Run focused tests and verify RED**

Run `cargo test account_keeper --lib` from `src-tauri`; expect missing command/helper failures.

- [ ] **Step 3: Implement safe public DTOs and commands**

Replace `ManagedProfileImportPayload` with:

```rust
pub struct ManagedProfileCodexAuth {
    pub status: String,
    pub expires_at: Option<String>,
    pub has_account_id: bool,
}
```

Add commands:

```rust
account_keeper_connect_codex(request: OpenProfileRequest)
account_keeper_copy_codex_export(app: tauri::AppHandle, request: CodexExportRequest)
account_keeper_save_codex_export(request: CodexSaveExportRequest)
```

`CodexExportRequest` carries only profile IDs and `nine_router | cockpit`. The Rust
command loads/refreshes protected credentials, serializes a JSON array, writes the
clipboard through `ClipboardExt` or atomically writes the selected path, zeroizes
the temporary string bytes where practical, and returns counts only.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run `cargo test account_keeper --lib` and ensure public serialization tests reject
`access_token`, `refresh_token`, `id_token`, full email, and token values.

### Task 5: Frontend Contracts And Red Tests

**Files:**
- Modify: `src/account-keeper/types.ts`
- Modify: `src/account-keeper/model.ts`
- Modify: `src/account-keeper/model.test.ts`
- Modify: `src/account-keeper/AccountKeeper.test.tsx`

- [ ] **Step 1: Replace profile-reference fixtures with readiness fixtures**

```typescript
codex_auth: {
  status: "ready",
  expires_at: "2026-08-18T03:00:00Z",
  has_account_id: true,
}
```

Add failing tests for `Connect Codex`, `Reconnect Codex`, `Export`, both copy
commands, save-dialog command payloads, and bulk ready-profile IDs. Assert rendered
text and mock invoke arguments contain no token-shaped fields.

- [ ] **Step 2: Run React tests and verify RED**

Run:

```powershell
npm.cmd test -- src/account-keeper/model.test.ts src/account-keeper/AccountKeeper.test.tsx
```

Expected: failures because the old `import_payload` UI still exists.

- [ ] **Step 3: Update TypeScript normalization and remove old formatter**

Delete `ProfileImportPayload` and `profileImportJson`. Normalize only the safe
`codex_auth` fields and reject malformed statuses outside
`missing | ready | reconnect_required`.

- [ ] **Step 4: Run model tests and verify GREEN**

Run `npm.cmd test -- src/account-keeper/model.test.ts`.

### Task 6: React UI Implementation

**Files:**
- Modify: `src/account-keeper/AccountKeeper.tsx`
- Modify: `src/account-keeper/AccountKeeper.css`
- Test: `src/account-keeper/AccountKeeper.test.tsx`

- [ ] **Step 1: Implement connect/reconnect/export handlers**

Use backend-only commands; never request JSON text:

```typescript
await invoke("account_keeper_copy_codex_export", {
  request: { profileIds, format: "nine_router" },
});
```

For save actions, use `saveDialog` to select a path, then pass only that path,
profile IDs, and format to `account_keeper_save_codex_export`.

- [ ] **Step 2: Replace the old import-reference panel**

Render redacted status/expiry and four format actions. Add section-level bulk
export using only profiles whose `codex_auth.status === "ready"`.

- [ ] **Step 3: Run React tests and verify GREEN**

Run the Task 5 command, then `npm.cmd run build`.

### Task 7: Documentation, Packaging, And Final Verification

**Files:**
- Modify: `docs/account-keeper.md`
- Modify: `docs/account-keeper.vn.md`
- Generated verification: `src-tauri/resources/account-keeper/`

- [ ] **Step 1: Update operator documentation**

Document Connect/Reconnect, direct 9Router/Cockpit import shapes, bulk export,
plaintext token handling, refresh behavior, and recovery from denied/expired OAuth.
Remove statements claiming Import Info never exports session tokens.

- [ ] **Step 2: Build the worker bundle**

Run:

```powershell
npm.cmd run build:account-keeper-worker
```

Expected: manifest generation succeeds with the modified worker graph.

- [ ] **Step 3: Run complete focused verification**

```powershell
Push-Location automation
npm.cmd test
Pop-Location
npm.cmd test -- src/account-keeper/model.test.ts src/account-keeper/AccountKeeper.test.tsx
Push-Location src-tauri
cargo test account_keeper --lib
Pop-Location
npm.cmd run build
git diff --check
git status --short
```

- [ ] **Step 4: Scan the diff for secret leakage**

Search only repository changes and confirm no value from the two supplied live JSON
files appears in tracked or new files. Tests use reserved synthetic strings only.

No commits or branches are created unless the operator explicitly requests them.
