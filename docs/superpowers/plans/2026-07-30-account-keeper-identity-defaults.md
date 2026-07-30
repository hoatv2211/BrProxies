# Account Keeper Identity Challenge and Defaults Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete OpenAI current-password/TOTP identity challenges during password reset and pre-populate a validated password template plus Documents output path.

**Architecture:** Keep normal login classification unchanged and add password-change-specific adapter classification for identity verification. Extend the existing password-change state machine to submit the current password once and reuse the existing TOTP protocol. Expose non-secret defaults from Rust so React can load and validate them without guessing OS paths.

**Tech Stack:** Node.js ESM worker, Patchright semantic locators, Node test runner, Rust/Tauri commands, React 19, TypeScript, Vitest, Testing Library.

---

## File Map

- Modify `automation/account-keeper-flow.mjs`: identity challenge and TOTP handling during password change.
- Modify `automation/adapters/openai-chatgpt-v1.mjs`: contextual identity classification and semantic password submission.
- Modify `automation/adapters/fixture-v1.mjs`: synthetic identity action support.
- Modify `automation/tests/account-keeper-flow.test.mjs`: worker and adapter regression coverage.
- Modify `src-tauri/src/account_keeper.rs`: default DTO, path resolver, and Tauri command.
- Modify `src-tauri/src/lib.rs`: register the defaults command without disturbing existing dirty action changes.
- Modify `src/account-keeper/types.ts`: frontend defaults DTO.
- Modify `src/account-keeper/AccountKeeper.tsx`: load defaults and validate the template on mount.
- Modify `src/account-keeper/AccountKeeper.test.tsx`: default-loading and override tests.

### Task 1: Password-Change Identity State Machine

**Files:**
- Modify: `automation/account-keeper-flow.mjs:210-248`
- Modify: `automation/adapters/fixture-v1.mjs:34-112`
- Test: `automation/tests/account-keeper-flow.test.mjs`

- [ ] **Step 1: Write failing identity transition tests**

Add synthetic state sequences covering a direct identity challenge, identity plus
TOTP, and a repeated unchanged identity form:

~~~js
test("completes a password-change identity challenge", async () => {
  const { page, events } = await execute([
    "login_ready",
    "signed_in",
    "identity_challenge",
    "password_change_ready",
    "password_changed",
    "login_ready",
    "signed_in",
  ]);
  assert.equal(events.at(-1).type, "verified");
  assert.equal(
    page.actions.filter((action) => action.type === "submit_identity_challenge").length,
    1,
  );
});

test("uses TOTP after the password-change identity challenge", async () => {
  const { page, events } = await execute([
    "login_ready",
    "signed_in",
    "identity_challenge",
    "totp_required",
    "password_change_ready",
    "password_changed",
    "login_ready",
    "signed_in",
  ], [{ type: "totp_code", code: "123456" }]);
  assert.equal(events.at(-1).type, "verified");
  assert.deepEqual(
    page.actions.filter((action) => action.type === "submit_totp").map((action) => action.code),
    ["123456"],
  );
});

test("fails an unchanged repeated identity challenge without looping", async () => {
  const { page, events } = await execute([
    "login_ready",
    "signed_in",
    "identity_challenge",
    "identity_challenge",
  ]);
  assert.equal(events.at(-1).type, "failed");
  assert.equal(events.at(-1).code, "password_change_failed");
  assert.equal(
    page.actions.filter((action) => action.type === "submit_identity_challenge").length,
    1,
  );
});
~~~

- [ ] **Step 2: Run the worker tests and verify RED**

Run:

~~~powershell
node --test tests/account-keeper-flow.test.mjs
~~~

Expected: the new tests fail because `identity_challenge` is not handled and
`submitIdentityChallenge` does not exist.

- [ ] **Step 3: Add fixture identity support**

Add password-change classification and a synthetic action:

~~~js
async classifyPasswordChange(page) {
  return this.classify(page);
},

async submitIdentityChallenge(page, password, { control } = {}) {
  control?.throwIfCancelled?.();
  if (isSyntheticPage(page)) {
    page.actions.push({ type: "submit_identity_challenge", password });
    return;
  }
  await page.getByLabel("Identity password", { exact: true }).fill(password);
  control?.throwIfCancelled?.();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  control?.throwIfCancelled?.();
},
~~~

- [ ] **Step 4: Extend the password-change state machine**

Add a contextual classifier helper:

~~~js
async function classifyPasswordChange({ pageSource, adapter, control }) {
  return normalizeState(
    await runPageRead({
      pageSource,
      adapter,
      control,
      read: (currentPage) => typeof adapter.classifyPasswordChange === "function"
        ? adapter.classifyPasswordChange(currentPage)
        : adapter.classify(currentPage),
    }),
  );
}
~~~

Update `changePassword` to track one identity submission and reuse the existing
TOTP command protocol:

~~~js
let identitySubmitted = false;
let totpAttempts = 0;
let totpPending = false;

let result = await classifyPasswordChange({ pageSource, adapter, control });
if (result.state === "totp_required" && totpPending) {
  result = await waitForTotpTransition({ pageSource, adapter, control });
}

case "identity_challenge":
  if (identitySubmitted) throw flowError("password_change_failed");
  await runPageAction({
    pageSource,
    adapter,
    control,
    action: (currentPage) => adapter.submitIdentityChallenge(
      currentPage,
      request.current_password,
      { control },
    ),
  });
  identitySubmitted = true;
  break;

case "totp_required":
case "totp_rejected":
  if (result.state === "totp_rejected") totpPending = false;
  if (totpAttempts >= 2) {
    await waitForManual({
      result: await securityChallengeResult(pageSource, adapter, control),
      request,
      send,
      control,
    });
    break;
  }
  await send({ type: "stage", stage: "submitting_totp" });
  await send({ type: "totp_required" });
  {
    const command = await waitForExpected(control, "totp_code", request.request_id);
    await runPageAction({
      pageSource,
      adapter,
      control,
      action: (currentPage) => adapter.submitTotp(currentPage, command.code, { control }),
    });
  }
  totpAttempts += 1;
  totpPending = true;
  break;
~~~

- [ ] **Step 5: Run the worker tests and verify GREEN**

Run:

~~~powershell
node --test tests/account-keeper-flow.test.mjs
~~~

Expected: all account-keeper flow tests pass.

- [ ] **Step 6: Commit the state-machine change**

~~~powershell
git add -- automation/account-keeper-flow.mjs automation/adapters/fixture-v1.mjs automation/tests/account-keeper-flow.test.mjs
git commit -m "feat(account-keeper): handle identity challenge"
~~~

### Task 2: OpenAI Identity Adapter

**Files:**
- Modify: `automation/adapters/openai-chatgpt-v1.mjs:23-145`
- Test: `automation/tests/account-keeper-flow.test.mjs`

- [ ] **Step 1: Write failing localized adapter tests**

Add focused adapter tests with a dynamic current-password locator. Generic
classification must remain `login_ready`, while password-change classification
returns `identity_challenge`. Submission must fill the supplied password, click
the semantic submit control once, and wait for two consecutive hidden polls.

~~~js
test("OpenAI adapter classifies the reset current-password form contextually", async () => {
  const page = identityChallengePage();

  assert.equal(await openaiChatgptAdapter.classify(page), "login_ready");
  assert.equal(
    await openaiChatgptAdapter.classifyPasswordChange(page),
    "identity_challenge",
  );
});

test("OpenAI adapter submits and waits out the identity password form", async () => {
  const page = identityChallengePage({ passwordVisibleTicks: 3 });

  await openaiChatgptAdapter.submitIdentityChallenge(
    page,
    "synthetic-current",
  );

  assert.equal(page.filledPassword, "synthetic-current");
  assert.equal(page.submitClicks, 1);
  assert.equal(page.passwordVisibleTicks <= 0, true);
  assert.equal(page.waitTicks, 4);
});

function identityChallengePage({ passwordVisibleTicks = 1 } = {}) {
  const page = {
    filledPassword: null,
    passwordVisibleTicks,
    submitClicks: 0,
    waitTicks: 0,
    url: () => "https://auth.openai.com/log-in/password",
    locator(selector) {
      const password = selector.includes('autocomplete="current-password"');
      const submit = selector === 'button[type="submit"], input[type="submit"]';
      return {
        first() { return this; },
        filter() { return this; },
        async isVisible() {
          return password || submit ? page.passwordVisibleTicks > 0 : false;
        },
        async fill(value) {
          if (password) page.filledPassword = value;
        },
        async click() {
          if (submit) page.submitClicks += 1;
        },
      };
    },
    getByRole() {
      return {
        first() { return this; },
        filter() { return this; },
        async isVisible() { return false; },
      };
    },
    async waitForTimeout() {
      page.waitTicks += 1;
      page.passwordVisibleTicks -= 1;
    },
  };
  return page;
}
~~~

- [ ] **Step 2: Run the adapter tests and verify RED**

Run:

~~~powershell
node --test tests/account-keeper-flow.test.mjs
~~~

Expected: failure because the OpenAI adapter lacks both identity methods.

- [ ] **Step 3: Implement contextual classification and submission**

Add methods that reuse existing semantic locators and the cancellable hidden wait:

~~~js
async classifyPasswordChange(page) {
  const state = await this.classify(page);
  if (state === "login_ready" && await visible(currentPassword(page))) {
    return "identity_challenge";
  }
  return state;
},

async submitIdentityChallenge(page, password, { control } = {}) {
  const input = currentPassword(page);
  if (!(await visible(input))) throw adapterError("flow_changed");
  await browserSideEffect(control, () => input.fill(password));
  await clickFirstVisible([
    page.getByRole("button", { name: /^(continue|verify|submit)$/i }),
    submitControl(page),
  ], control);
  await waitUntilHidden(page, input, 15_000, control);
},
~~~

- [ ] **Step 4: Run focused and complete automation tests**

Run:

~~~powershell
node --test tests/account-keeper-flow.test.mjs
npm.cmd test
~~~

Expected: focused tests pass and the full automation suite reports zero failures.

- [ ] **Step 5: Commit the OpenAI adapter change**

~~~powershell
git add -- automation/adapters/openai-chatgpt-v1.mjs automation/tests/account-keeper-flow.test.mjs
git commit -m "fix(account-keeper): submit identity password"
~~~

### Task 3: Backend Default Configuration

**Files:**
- Modify: `src-tauri/src/account_keeper.rs:250-300,1133-1156`
- Modify: `src-tauri/src/lib.rs:1157-1160`
- Test: `src-tauri/src/account_keeper.rs` test module

- [ ] **Step 1: Write the failing Rust defaults test**

Add a pure helper test that does not depend on the host Documents directory:

~~~rust
#[test]
fn default_config_uses_documents_output_and_valid_template() {
    let defaults = default_config_for(Path::new(r"C:\Users\synthetic\Documents"));
    assert_eq!(defaults.template, "BrP@{random:16}!");
    assert_eq!(
        defaults.output_path,
        r"C:\Users\synthetic\Documents\account-keeper-result.json"
    );
    assert!(validate_template_value(&defaults.template).unwrap().valid);
}
~~~

- [ ] **Step 2: Run the Rust test and verify RED**

Run:

~~~powershell
cargo test default_config_uses_documents_output_and_valid_template --manifest-path src-tauri/Cargo.toml
~~~

Expected: compile failure because `default_config_for` and the DTO do not exist.

- [ ] **Step 3: Add DTO, resolver, and Tauri command**

Add the non-secret response type and pure helper:

~~~rust
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountKeeperDefaultsDto {
    pub template: String,
    pub output_path: String,
}

fn default_config_for(document_dir: &Path) -> AccountKeeperDefaultsDto {
    AccountKeeperDefaultsDto {
        template: "BrP@{random:16}!".to_string(),
        output_path: document_dir
            .join("account-keeper-result.json")
            .to_string_lossy()
            .to_string(),
    }
}

#[tauri::command]
pub fn account_keeper_defaults() -> std::result::Result<AccountKeeperDefaultsDto, String> {
    let document_dir = dirs::document_dir()
        .ok_or_else(|| "OS Documents directory unavailable".to_string())?;
    Ok(default_config_for(&document_dir))
}
~~~

Register `account_keeper::account_keeper_defaults` adjacent to the existing
Account Keeper validation commands in `src-tauri/src/lib.rs`. Preserve the
uncommitted profile-actions changes already present in that file.

- [ ] **Step 4: Run focused Rust tests and compile check**

Run:

~~~powershell
cargo test default_config_uses_documents_output_and_valid_template --manifest-path src-tauri/Cargo.toml
cargo check --manifest-path src-tauri/Cargo.toml
~~~

Expected: the focused test passes and cargo check exits zero with only existing
warnings.

- [ ] **Step 5: Commit only the defaults hunks**

Stage `src-tauri/src/account_keeper.rs` normally. Stage only the new handler line
from dirty `src-tauri/src/lib.rs` with this cached patch, then verify the cached
diff contains no action-plugin work.

~~~powershell
git add -- src-tauri/src/account_keeper.rs
$libPatch = @'
diff --git a/src-tauri/src/lib.rs b/src-tauri/src/lib.rs
--- a/src-tauri/src/lib.rs
+++ b/src-tauri/src/lib.rs
@@ -1147,0 +1148 @@
+            account_keeper::account_keeper_defaults,
'@
$libPatchPath = Join-Path $env:TEMP 'account-keeper-lib.patch'
[IO.File]::WriteAllText(
  $libPatchPath,
  $libPatch.Replace("`r", "") + "`n",
  [Text.UTF8Encoding]::new($false)
)
git apply --cached --unidiff-zero $libPatchPath
Remove-Item -LiteralPath $libPatchPath
git diff --cached -- src-tauri/src/lib.rs
git diff --cached --check
git commit -m "feat(account-keeper): provide form defaults"
~~~

### Task 4: React Default Loading and Validation

**Files:**
- Modify: `src/account-keeper/types.ts:71-83`
- Modify: `src/account-keeper/AccountKeeper.tsx:174-328`
- Modify: `src/account-keeper/AccountKeeper.test.tsx:24-60`

- [ ] **Step 1: Write failing UI default tests**

Extend the invoke mock:

~~~ts
if (command === "account_keeper_defaults") {
  return {
    template: "BrP@{random:16}!",
    outputPath: "C:\\Users\\synthetic\\Documents\\account-keeper-result.json",
  };
}
~~~

Add a mount test:

~~~tsx
it("loads and validates editable defaults on mount", async () => {
  render(<AccountKeeper confirm={vi.fn().mockResolvedValue(true)} />);

  await waitFor(() => expect(screen.getByLabelText("Template"))
    .toHaveValue("BrP@{random:16}!"));
  expect(screen.getByLabelText("Output file")).toHaveValue(
    "C:\\Users\\synthetic\\Documents\\account-keeper-result.json",
  );
  expect(mocks.invoke).toHaveBeenCalledWith(
    "account_keeper_validate_template",
    { request: { template: "BrP@{random:16}!" } },
  );
  expect(await screen.findByText("Template valid")).toBeInTheDocument();

  fireEvent.change(screen.getByLabelText("Template"), {
    target: { value: "Local-{random:16}" },
  });
  expect(screen.queryByText("Template valid")).not.toBeInTheDocument();
});
~~~

- [ ] **Step 2: Run the UI test and verify RED**

Run:

~~~powershell
npm.cmd test -- src/account-keeper/AccountKeeper.test.tsx
~~~

Expected: failure because the component does not request or apply defaults.

- [ ] **Step 3: Add the defaults DTO and normalizer**

Add to `types.ts`:

~~~ts
export interface AccountKeeperDefaultsDto {
  template: string;
  outputPath: string;
}
~~~

Add a strict normalizer in `AccountKeeper.tsx` that rejects missing or blank
fields instead of accepting malformed backend data.

~~~ts
function normalizeDefaults(value: unknown): AccountKeeperDefaultsDto {
  const record = asRecord(value);
  const template = asString(record?.template).trim();
  const outputPath = asString(record?.outputPath ?? record?.output_path).trim();
  if (!template || !outputPath) {
    throw new Error("Invalid Account Keeper defaults");
  }
  return { template, outputPath };
}
~~~

- [ ] **Step 4: Load defaults and validate without overwriting operator edits**

Add a mount effect that requests defaults, validates the returned template, and
applies each field only if that draft field is still blank:

~~~tsx
useEffect(() => {
  let disposed = false;
  const loadDefaults = async () => {
    try {
      const defaults = normalizeDefaults(
        await invoke<unknown>("account_keeper_defaults"),
      );
      const validation = normalizeTemplateValidation(
        await invoke<unknown>("account_keeper_validate_template", {
          request: { template: defaults.template },
        }),
      );
      if (disposed) return;
      setDraft((current) => {
        const applyTemplate = current.templateText.trim() === "";
        return {
          ...current,
          templateText: applyTemplate ? defaults.template : current.templateText,
          templateValidation: applyTemplate ? validation : current.templateValidation,
          outputPath: current.outputPath.trim() === ""
            ? defaults.outputPath
            : current.outputPath,
        };
      });
    } catch (defaultsError) {
      if (!disposed) setError(String(defaultsError));
    }
  };
  void loadDefaults();
  return () => { disposed = true; };
}, []);
~~~

The existing input edit, template edit, validation button, Browse button, and
plaintext acknowledgement remain unchanged.

- [ ] **Step 5: Run focused UI and frontend tests**

Run:

~~~powershell
npm.cmd test -- src/account-keeper/AccountKeeper.test.tsx
npm.cmd test
npm.cmd run build
~~~

Expected: Account Keeper tests pass, the full Vitest suite has zero failures, and
TypeScript/Vite build exits zero.

- [ ] **Step 6: Commit the UI defaults**

~~~powershell
git add -- src/account-keeper/types.ts src/account-keeper/AccountKeeper.tsx src/account-keeper/AccountKeeper.test.tsx
git commit -m "feat(account-keeper): preload valid defaults"
~~~

### Task 5: Release Verification

**Files:**
- Verify only; no planned source edits.

- [ ] **Step 1: Run all worker tests**

~~~powershell
Set-Location automation
npm.cmd test
Set-Location ..
~~~

Expected: all worker tests pass.

- [ ] **Step 2: Run all frontend tests and build**

~~~powershell
npm.cmd test
npm.cmd run build
~~~

Expected: all frontend tests pass and Vite production build exits zero.

- [ ] **Step 3: Run focused Rust tests and checks**

~~~powershell
cargo test account_keeper --manifest-path src-tauri/Cargo.toml
cargo check --manifest-path src-tauri/Cargo.toml
~~~

Expected: Account Keeper Rust tests pass and cargo check exits zero.

- [ ] **Step 4: Build the release with the launcher running**

~~~powershell
& '.\smart launch\build.bat'
~~~

Expected: the smart build stops the running launcher, stages updated Account Keeper
resources, and exits zero.

- [ ] **Step 5: Verify packaged worker hashes**

~~~powershell
$paths = @(
  'automation/account-keeper-flow.mjs',
  'src-tauri/resources/account-keeper/worker/account-keeper-flow.mjs',
  'src-tauri/target/release/account-keeper/worker/account-keeper-flow.mjs'
)
Get-FileHash -Algorithm SHA256 $paths

$paths = @(
  'automation/account-keeper-worker-runtime.mjs',
  'src-tauri/resources/account-keeper/worker/account-keeper-worker-runtime.mjs',
  'src-tauri/target/release/account-keeper/worker/account-keeper-worker-runtime.mjs'
)
Get-FileHash -Algorithm SHA256 $paths

$paths = @(
  'automation/adapters/openai-chatgpt-v1.mjs',
  'src-tauri/resources/account-keeper/worker/adapters/openai-chatgpt-v1.mjs',
  'src-tauri/target/release/account-keeper/worker/adapters/openai-chatgpt-v1.mjs'
)
Get-FileHash -Algorithm SHA256 $paths
~~~

Expected: each source/resource/release group has one identical hash.

- [ ] **Step 6: Restart and smoke-check the launcher**

~~~powershell
& '.\smart launch\run.bat'
Start-Sleep -Seconds 5
Invoke-WebRequest -UseBasicParsing http://127.0.0.1:40325/health
~~~

Expected: one responding BrProxies process and HTTP 200 health response. The
terminal failed job cannot be resumed; create a new batch for the real identity
challenge smoke test.
