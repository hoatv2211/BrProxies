# Account Keeper Inline Input Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add memory-only pasted Account Keeper input while preserving the existing local-file workflow, parser, size limit, masking, encrypted vault, profile reuse, and recovery behavior.

**Architecture:** Introduce one tagged `InputSource` union at the React/Tauri boundary. Rust validates and parses both source variants through one loader; React stores pasted text only in component state and clears its reference after a successful start. Existing vault, checkpoint, output, worker, provider adapter, and resume formats remain unchanged.

**Tech Stack:** Rust 2021, Serde, Tauri 2, React 19, TypeScript 5.8, Vitest, Testing Library, Patchright QA, PowerShell.

---

## File Map

- Modify `src-tauri/src/account_keeper.rs`: tagged source DTO, shared bounded loader, command routing, request validation, redaction tests.
- Modify `src/account-keeper/types.ts`: `InputMode`, `InputSource`, and expanded draft state.
- Modify `src/account-keeper/model.ts`: active-source construction and start eligibility.
- Modify `src/account-keeper/model.test.ts`: active inline/file eligibility tests.
- Modify `src/account-keeper/AccountKeeper.tsx`: paste/file UI, explicit validation, tagged IPC, QA bridge, successful-start clearing.
- Modify `src/account-keeper/AccountKeeper.css`: compact source selector and multiline input styles.
- Modify `src/account-keeper/AccountKeeper.test.tsx`: component behavior and exact IPC payload tests.
- Modify `automation/qa/account-keeper-tauri-qa.mjs`: first inline batch, later file batches, profile reuse, redacted diagnostics.
- Modify `docs/account-keeper.md`: English usage and memory-only security wording.
- Modify `docs/account-keeper.vn.md`: Vietnamese usage and memory-only security wording.

Do not modify vault/checkpoint schemas, provider adapters, worker protocol, `src/App.tsx`, `src-tauri/src/lib.rs`, or unrelated dirty files.

### Task 1: Define The Tagged Rust Input Contract

**Files:**
- Modify: `src-tauri/src/account_keeper.rs:248-269`
- Test: `src-tauri/src/account_keeper.rs:2584-2660`

- [ ] **Step 1: Write failing tagged-source deserialization tests**

Add these tests inside `account_keeper::tests`:

```rust
#[test]
fn input_source_deserializes_inline_and_file_variants() {
    let inline: InputSource = serde_json::from_value(serde_json::json!({
        "kind": "inline",
        "text": "owner@example.test|current-password|JBSWY3DPEHPK3PXP"
    }))
    .unwrap();
    assert!(matches!(
        inline,
        InputSource::Inline { text }
            if text == "owner@example.test|current-password|JBSWY3DPEHPK3PXP"
    ));

    let file: InputSource = serde_json::from_value(serde_json::json!({
        "kind": "file",
        "path": "C:\\fixtures\\batch.txt"
    }))
    .unwrap();
    assert!(matches!(
        file,
        InputSource::File { path } if path == "C:\\fixtures\\batch.txt"
    ));
}

#[test]
fn input_source_rejects_missing_unknown_and_mixed_payloads() {
    for payload in [
        serde_json::json!({}),
        serde_json::json!({ "kind": "unknown", "text": "synthetic" }),
        serde_json::json!({ "kind": "inline", "text": "synthetic", "path": "C:\\mixed.txt" }),
        serde_json::json!({ "kind": "file", "path": "C:\\batch.txt", "text": "synthetic" }),
    ] {
        assert!(serde_json::from_value::<InputSource>(payload).is_err());
    }
}
```

- [ ] **Step 2: Run focused Rust test and confirm RED**

Run:

```powershell
cargo test --manifest-path src-tauri\Cargo.toml account_keeper::tests::input_source_ -- --nocapture
```

Expected: compilation fails because `InputSource` does not exist.

- [ ] **Step 3: Add the non-loggable tagged enum**

Insert before `PreviewRequest`:

```rust
#[derive(Clone, PartialEq, Eq, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum InputSource {
    Inline { text: String },
    File { path: String },
}
```

Do not derive `Debug` or `Serialize`; source may contain plaintext credentials and is request-only.

- [ ] **Step 4: Run focused Rust test and confirm GREEN**

Run:

```powershell
cargo test --manifest-path src-tauri\Cargo.toml account_keeper::tests::input_source_ -- --nocapture
```

Expected: both tagged-source tests pass.

- [ ] **Step 5: Commit the contract**

```powershell
git add -- src-tauri/src/account_keeper.rs
git commit -m "refactor(account-keeper): define input sources"
```

### Task 2: Route Rust Validation And Start Through One Loader

**Files:**
- Modify: `src-tauri/src/account_keeper.rs:248-269`
- Modify: `src-tauri/src/account_keeper.rs:812-826`
- Modify: `src-tauri/src/account_keeper.rs:1080-1142`
- Modify: `src-tauri/src/account_keeper.rs:1400-1423`
- Test: `src-tauri/src/account_keeper.rs:2584-3185`

- [ ] **Step 1: Write failing loader, bounds, and redaction tests**

Add these tests inside `account_keeper::tests`:

```rust
#[test]
fn inline_and_file_sources_parse_identically() {
    let text = "owner@example.test|part|two|JBSWY3DPEHPK3PXP\n";
    let path = test_dir("input-source-equivalence").join("batch.txt");
    std::fs::write(&path, text).unwrap();

    let inline = read_input_accounts(&InputSource::Inline {
        text: text.to_string(),
    })
    .unwrap();
    let file = read_input_accounts(&InputSource::File {
        path: path.to_string_lossy().to_string(),
    })
    .unwrap();

    assert_eq!(inline, file);
    assert_eq!(inline[0].current_password, "part|two");
}

#[test]
fn input_sources_reject_empty_and_oversized_values_without_echoing_secrets() {
    let empty = read_input_accounts(&InputSource::Inline { text: String::new() })
        .unwrap_err()
        .to_string();
    assert!(empty.contains("required"));

    let secret = "SYNTHETIC_SECRET_FRAGMENT";
    let oversized = format!("{secret}{}", "x".repeat(ACCOUNT_KEEPER_INPUT_LIMIT));
    let error = read_input_accounts(&InputSource::Inline { text: oversized })
        .unwrap_err()
        .to_string();
    assert_eq!(error, "Account Keeper input is too large");
    assert!(!error.contains(secret));
}

#[test]
fn start_request_rejects_empty_output_and_same_file_paths() {
    let inline = StartRequest {
        source: InputSource::Inline {
            text: "owner@example.test|current-password|JBSWY3DPEHPK3PXP".into(),
        },
        output_path: String::new(),
        template: "Local-{random:16}".into(),
        adapter_id: "fixture-v1".into(),
        keep_profile_running: false,
        pause_after_current: false,
    };
    assert!(validate_start_request(&inline).is_err());

    let file = StartRequest {
        source: InputSource::File {
            path: "C:/synthetic/batch.txt".into(),
        },
        output_path: "C:/synthetic/batch.txt".into(),
        ..inline
    };
    assert!(validate_start_request(&file).is_err());
}

#[test]
fn inline_source_is_absent_from_checkpoint_and_job_view() {
    let source_text = "owner@example.test|current-password|JBSWY3DPEHPK3PXP";
    let imports = read_input_accounts(&InputSource::Inline {
        text: source_text.into(),
    })
    .unwrap();
    let runtime = FakeProfileRuntime {
        fingerprints: vec![FingerprintCandidate::new("windows-a", "Alpha", "Windows")],
        ..Default::default()
    };
    let mut vault = VaultFile::default();
    let request = StartRequest {
        source: InputSource::Inline { text: source_text.into() },
        output_path: "C:/synthetic/result.json".into(),
        template: "Local-{random:16}".into(),
        adapter_id: "fixture-v1".into(),
        keep_profile_running: false,
        pause_after_current: false,
    };
    let checkpoint = merge_imports_and_checkpoint(
        &runtime,
        &mut vault,
        &imports,
        &request,
        "batch-inline",
        "2026-07-30T00:00:00Z",
    )
    .unwrap();
    let view = job_view_from_checkpoint(&checkpoint, &vault);
    let persisted = format!(
        "{} {}",
        serde_json::to_string(&checkpoint).unwrap(),
        serde_json::to_string(&view).unwrap()
    )
    .to_lowercase();

    for forbidden in [
        "owner@example.test",
        "current-password",
        "jbswy3dpehpk3pxp",
        "source_text",
        "inputsource",
    ] {
        assert!(!persisted.contains(forbidden));
    }
}
```

- [ ] **Step 2: Replace request fields in existing tests and confirm RED**

Update every existing test construction of `StartRequest` from:

```rust
StartRequest {
    input_path: path.to_string_lossy().to_string(),
    // existing non-source fields
}
```

to:

```rust
StartRequest {
    source: InputSource::File {
        path: path.to_string_lossy().to_string(),
    },
    // existing non-source fields
}
```

Run:

```powershell
cargo test --manifest-path src-tauri\Cargo.toml account_keeper::tests -- --nocapture
```

Expected: compilation fails because request DTOs and command flow still use `input_path`.

- [ ] **Step 3: Replace source-bearing request DTOs**

Use request-only derives and exact camelCase outer fields:

```rust
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreviewRequest {
    pub source: InputSource,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StartRequest {
    pub source: InputSource,
    pub output_path: String,
    pub template: String,
    pub adapter_id: String,
    pub keep_profile_running: bool,
    pub pause_after_current: bool,
}
```

Keep `TemplateRequest` unchanged. Do not add request fields to persisted DTOs.

- [ ] **Step 4: Implement the shared bounded loader**

Replace duplicated file reads with:

```rust
const ACCOUNT_KEEPER_INPUT_LIMIT: usize = 16 * 1024 * 1024;

fn validate_input_source_shape(source: &InputSource) -> Result<()> {
    match source {
        InputSource::Inline { text } => {
            if text.trim().is_empty() {
                bail!("Account Keeper input is required");
            }
            if text.len() > ACCOUNT_KEEPER_INPUT_LIMIT {
                bail!("Account Keeper input is too large");
            }
        }
        InputSource::File { path } => {
            if path.trim().is_empty() {
                bail!("Account Keeper input path is required");
            }
        }
    }
    Ok(())
}

fn read_input_accounts(source: &InputSource) -> Result<Vec<ImportedAccount>> {
    validate_input_source_shape(source)?;
    match source {
        InputSource::Inline { text } => parse_input(text),
        InputSource::File { path } => {
            let path = Path::new(path);
            let metadata = std::fs::metadata(path)?;
            if metadata.len() > ACCOUNT_KEEPER_INPUT_LIMIT as u64 {
                bail!("Account Keeper input is too large");
            }
            parse_input(&std::fs::read_to_string(path)?)
        }
    }
}

pub fn validate_input_source(source: &InputSource) -> Result<InputValidationDto> {
    let accounts = read_input_accounts(source)?;
    Ok(InputValidationDto {
        valid_count: accounts.len(),
        masked_accounts: accounts
            .iter()
            .map(|account| mask_account(&account.account))
            .collect(),
    })
}
```

`String::len()` is UTF-8 byte length. Never include source contents in errors.

- [ ] **Step 5: Route validation and start through `source`**

Update validation command:

```rust
#[tauri::command]
pub fn account_keeper_validate_input(
    request: PreviewRequest,
) -> std::result::Result<InputValidationDto, String> {
    validate_input_source(&request.source).map_err(|error| error.to_string())
}
```

Update batch setup:

```rust
let imports = read_input_accounts(&request.source)?;
```

Update start validation without treating inline text as a path:

```rust
fn validate_start_request(request: &StartRequest) -> Result<()> {
    validate_input_source_shape(&request.source)?;
    if request.output_path.trim().is_empty() {
        bail!("Account Keeper output path is required");
    }
    if let InputSource::File { path } = &request.source {
        if Path::new(path) == Path::new(&request.output_path) {
            bail!("Account Keeper input and output paths must differ");
        }
    }
    if !matches!(
        request.adapter_id.as_str(),
        "fixture-v1" | "openai-chatgpt-v1"
    ) {
        bail!("unsupported Account Keeper adapter");
    }
    PasswordTemplate::parse(&request.template)?;
    Ok(())
}
```

Delete `validate_input_path`; all callers use `validate_input_source` or `read_input_accounts`.

- [ ] **Step 6: Run Rust tests and confirm GREEN**

Run:

```powershell
cargo fmt --manifest-path src-tauri\Cargo.toml
cargo test --manifest-path src-tauri\Cargo.toml account_keeper::tests -- --nocapture
cargo test --manifest-path src-tauri\Cargo.toml account_keeper_format::tests -- --nocapture
```

Expected: formatting passes; coordinator and parser tests pass, including password-with-pipe and redaction cases.

- [ ] **Step 7: Commit backend routing**

```powershell
git add -- src-tauri/src/account_keeper.rs
git commit -m "feat(account-keeper): load inline input"
```

### Task 3: Model Active Inline And File Drafts

**Files:**
- Modify: `src/account-keeper/types.ts:25-74`
- Modify: `src/account-keeper/model.ts:1-25`
- Test: `src/account-keeper/model.test.ts:1-84`

- [ ] **Step 1: Write failing source and start-eligibility tests**

Import `activeInputSource` and expand `validDraft`:

```typescript
const validDraft: DraftState = {
  inputMode: "inline",
  inputText: "owner@example.test|current-password|JBSWY3DPEHPK3PXP",
  inputPath: "C:\\fixtures\\batch.txt",
  outputPath: "C:\\fixtures\\result.json",
  templateText: "Local-{random:16}",
  keepProfileRunning: false,
  plaintextAcknowledged: true,
  inputValidation: {
    validCount: 2,
    maskedAccounts: ["o***r@example.test", "a***n@example.test"],
  },
  templateValidation: {
    valid: true,
    finalLength: 22,
    hasUppercase: true,
    hasLowercase: true,
    hasDigit: true,
    hasSymbol: true,
  },
};
```

Add:

```typescript
describe("activeInputSource", () => {
  it("builds only the active tagged source", () => {
    expect(activeInputSource(validDraft)).toEqual({
      kind: "inline",
      text: validDraft.inputText,
    });
    expect(activeInputSource({ ...validDraft, inputMode: "file" })).toEqual({
      kind: "file",
      path: validDraft.inputPath,
    });
  });
});

describe("canStart", () => {
  it("requires content for the active source only", () => {
    expect(canStart({ ...validDraft, inputText: "" }, [])).toBe(false);
    expect(canStart({ ...validDraft, inputPath: "" }, [])).toBe(true);
    expect(canStart({ ...validDraft, inputMode: "file", inputPath: "" }, [])).toBe(false);
    expect(canStart({ ...validDraft, inputMode: "file", inputText: "" }, [])).toBe(true);
  });
});
```

Keep existing template, validation, blocking-job, resume, and progress tests.

- [ ] **Step 2: Run model test and confirm RED**

Run:

```powershell
npm.cmd test -- src/account-keeper/model.test.ts
```

Expected: TypeScript fails because `InputMode`, `inputText`, and `activeInputSource` do not exist.

- [ ] **Step 3: Add frontend source types**

Add to `types.ts`:

```typescript
export type InputMode = "inline" | "file";

export type InputSource =
  | { kind: "inline"; text: string }
  | { kind: "file"; path: string };
```

Expand `DraftState`:

```typescript
export interface DraftState {
  inputMode: InputMode;
  inputText: string;
  inputPath: string;
  outputPath: string;
  templateText: string;
  keepProfileRunning: boolean;
  plaintextAcknowledged: boolean;
  inputValidation: InputValidationDto | null;
  templateValidation: TemplateValidationDto | null;
}
```

- [ ] **Step 4: Add active-source construction and eligibility**

Update `model.ts` imports and add:

```typescript
import type {
  AccountStage,
  DraftState,
  InputSource,
  JobStatus,
  JobView,
  ProgressEvent,
} from "./types";

export function activeInputSource(draft: DraftState): InputSource {
  return draft.inputMode === "inline"
    ? { kind: "inline", text: draft.inputText }
    : { kind: "file", path: draft.inputPath };
}
```

Replace the first guard in `canStart`:

```typescript
const source = activeInputSource(draft);
const hasActiveInput = source.kind === "inline"
  ? source.text.trim().length > 0
  : source.path.trim().length > 0;
if (!hasActiveInput || !draft.outputPath.trim()) return false;
```

- [ ] **Step 5: Run model test and confirm GREEN**

Run:

```powershell
npm.cmd test -- src/account-keeper/model.test.ts
```

Expected: all model tests pass.

- [ ] **Step 6: Commit frontend model**

```powershell
git add -- src/account-keeper/types.ts src/account-keeper/model.ts src/account-keeper/model.test.ts
git commit -m "feat(account-keeper): model input modes"
```

### Task 4: Add Paste/File UI And Tagged IPC

**Files:**
- Modify: `src/account-keeper/AccountKeeper.tsx:1-49`
- Modify: `src/account-keeper/AccountKeeper.tsx:179-230`
- Modify: `src/account-keeper/AccountKeeper.tsx:337-441`
- Modify: `src/account-keeper/AccountKeeper.tsx:605-717`
- Modify: `src/account-keeper/AccountKeeper.css:135-169`
- Test: `src/account-keeper/AccountKeeper.test.tsx:19-168`

- [ ] **Step 1: Rewrite component tests for paste-first behavior**

Keep the Strict Mode subscription test, but replace its input-file assertion with:

```typescript
expect(screen.getByRole("button", { name: "Paste text" })).toHaveAttribute("aria-pressed", "true");
expect(screen.getByLabelText("Account input")).toBeInTheDocument();
expect(screen.getByRole("button", { name: "Validate Input" })).toBeInTheDocument();
```

Add a normal paste-flow test:

```typescript
it("validates pasted records, starts with inline source, and clears the textarea", async () => {
  mocks.save.mockResolvedValue("C:\\fixtures\\result.json");
  const confirm = vi.fn().mockResolvedValue(true);
  render(<AccountKeeper confirm={confirm} />);
  await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("account_keeper_list_jobs"));

  const input = "owner@example.test|current-password|JBSWY3DPEHPK3PXP\nadmin@example.test|second-password|";
  fireEvent.change(screen.getByLabelText("Account input"), { target: { value: input } });
  fireEvent.click(screen.getByRole("button", { name: "Validate Input" }));
  await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith(
    "account_keeper_validate_input",
    { request: { source: { kind: "inline", text: input } } },
  ));

  fireEvent.change(screen.getByLabelText("Template"), {
    target: { value: "Local-{random:16}" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Validate Template" }));
  fireEvent.click(screen.getByRole("button", { name: "Choose output file" }));
  await waitFor(() => expect(mocks.save).toHaveBeenCalled());
  fireEvent.click(screen.getByLabelText(
    "I understand pasted input and the output file contain plaintext secrets",
  ));

  const start = screen.getByRole("button", { name: "Start Batch" });
  await waitFor(() => expect(start).toBeEnabled());
  fireEvent.click(start);

  await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith(
    "account_keeper_start_batch",
    {
      request: {
        source: { kind: "inline", text: input },
        outputPath: "C:\\fixtures\\result.json",
        template: "Local-{random:16}",
        adapterId: "openai-chatgpt-v1",
        keepProfileRunning: false,
        pauseAfterCurrent: false,
      },
    },
  ));
  await waitFor(() => expect(screen.getByLabelText("Account input")).toHaveValue(""));
});
```

Add a mode-switch/file test:

```typescript
it("preserves both drafts, clears stale validation, and sends only file source", async () => {
  mocks.open.mockResolvedValue("C:\\fixtures\\batch.txt");
  render(<AccountKeeper confirm={vi.fn().mockResolvedValue(true)} />);
  await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("account_keeper_list_jobs"));
  expect(screen.getByLabelText("Template")).toBeEnabled();

  fireEvent.change(screen.getByLabelText("Account input"), {
    target: { value: "owner@example.test|current-password|JBSWY3DPEHPK3PXP" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Validate Input" }));
  expect(await screen.findByText("Input valid")).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Choose file" }));
  expect(screen.queryByText("Input valid")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Choose input file" }));
  await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith(
    "account_keeper_validate_input",
    { request: { source: { kind: "file", path: "C:\\fixtures\\batch.txt" } } },
  ));

  fireEvent.click(screen.getByRole("button", { name: "Paste text" }));
  expect(screen.getByLabelText("Account input")).toHaveValue(
    "owner@example.test|current-password|JBSWY3DPEHPK3PXP",
  );
  expect(screen.queryByText("Input valid")).not.toBeInTheDocument();
});
```

Update the dev-bridge test configuration to send:

```typescript
source: { kind: "file", path: "C:\\fixtures\\batch.txt" },
```

and expect `{ request: { source: { kind: "file", path: "C:\\fixtures\\batch.txt" } } }` for validation and start.

- [ ] **Step 2: Run component test and confirm RED**

Run:

```powershell
npm.cmd test -- src/account-keeper/AccountKeeper.test.tsx
```

Expected: tests fail because paste controls and tagged payloads are absent.

- [ ] **Step 3: Initialize paste mode and add safe source helpers**

Import `activeInputSource` and `InputSource`, then update the draft:

```typescript
const initialDraft: DraftState = {
  inputMode: "inline",
  inputText: "",
  inputPath: "",
  outputPath: "",
  templateText: "",
  keepProfileRunning: false,
  plaintextAcknowledged: false,
  inputValidation: null,
  templateValidation: null,
};
```

Add exact-source comparison for stale async results:

```typescript
function sameInputSource(left: InputSource, right: InputSource): boolean {
  if (left.kind === "inline") {
    return right.kind === "inline" && left.text === right.text;
  }
  return right.kind === "file" && left.path === right.path;
}
```

Add a strict dev-bridge source parser so mixed payloads are not copied into state:

```typescript
function normalizeQaInputSource(value: unknown): InputSource | null {
  const record = asRecord(value);
  if (!record || typeof record.kind !== "string") return null;
  const keys = Object.keys(record).sort().join(",");
  if (record.kind === "inline" && keys === "kind,text" && typeof record.text === "string") {
    return { kind: "inline", text: record.text };
  }
  if (record.kind === "file" && keys === "kind,path" && typeof record.path === "string") {
    return { kind: "file", path: record.path };
  }
  return null;
}
```

- [ ] **Step 4: Update the synthetic QA bridge to use tagged sources**

Parse and delete the dataset value immediately:

```typescript
const serialized = root.dataset.accountKeeperQaConfig ?? "null";
delete root.dataset.accountKeeperQaConfig;
const config = JSON.parse(serialized) as {
  source?: unknown;
  outputPath?: unknown;
  templateText?: unknown;
  adapterId?: unknown;
} | null;
const source = normalizeQaInputSource(config?.source);
if (
  !config
  || !source
  || typeof config.outputPath !== "string"
  || typeof config.templateText !== "string"
) {
  throw new Error("invalid synthetic QA configuration");
}
```

Validate and apply only the tagged source:

```typescript
const [inputValidation, templateValidation] = await Promise.all([
  invoke<unknown>("account_keeper_validate_input", {
    request: { source },
  }),
  invoke<unknown>("account_keeper_validate_template", {
    request: { template: config.templateText },
  }),
]);
setDraft((current) => ({
  ...current,
  inputMode: source.kind,
  inputText: source.kind === "inline" ? source.text : current.inputText,
  inputPath: source.kind === "file" ? source.path : current.inputPath,
  outputPath: config.outputPath as string,
  templateText: config.templateText as string,
  inputValidation: normalizeInputValidation(inputValidation),
  templateValidation: normalizeTemplateValidation(templateValidation),
}));
```

- [ ] **Step 5: Centralize explicit input validation**

Add one function used by both modes:

```typescript
const validateInputSource = async (source: InputSource) => {
  setBusyAction("validate-input");
  setError(null);
  try {
    const validation = normalizeInputValidation(
      await invoke<unknown>("account_keeper_validate_input", {
        request: { source },
      }),
    );
    setDraft((current) => sameInputSource(activeInputSource(current), source)
      ? { ...current, inputValidation: validation }
      : current);
  } catch (validationError) {
    setError(String(validationError));
  } finally {
    setBusyAction(null);
  }
};

const validateInput = async () => {
  await validateInputSource(activeInputSource(draft));
};
```

Replace `chooseInput` validation with:

```typescript
const source: InputSource = { kind: "file", path };
setDraft((current) => ({
  ...current,
  inputMode: "file",
  inputPath: path,
  inputValidation: null,
}));
await validateInputSource(source);
```

- [ ] **Step 6: Return success from `runAction` and clear pasted text**

Change the action helper to return an explicit result:

```typescript
const runAction = async (
  key: string,
  command: string,
  args: Record<string, unknown>,
  success: string,
  jobId?: string,
): Promise<boolean> => {
  setBusyAction(key);
  setError(null);
  setNotice(null);
  try {
    const result = await invoke<unknown>(command, args);
    if (!replaceJob(result) && jobId) await refreshJob(jobId);
    setNotice(success);
    return true;
  } catch (actionError) {
    setError(String(actionError));
    return false;
  } finally {
    setBusyAction(null);
  }
};
```

Update `startBatch`:

```typescript
const source = activeInputSource(draft);
const sourceDescription = source.kind === "inline" ? "pasted input" : "the selected input file";
const approved = await confirm({
  title: "Start Account Keeper batch",
  message: `${sourceDescription} and the output file contain plaintext secrets. Start this batch now?`,
  buttons: [
    { label: "Cancel", value: false },
    { label: "Start Batch", value: true, primary: true },
  ],
});
if (approved !== true) return;
const started = await runAction(
  "start",
  "account_keeper_start_batch",
  {
    request: {
      source,
      outputPath: draft.outputPath,
      template: draft.templateText,
      adapterId: qaAdapterId.current,
      keepProfileRunning: draft.keepProfileRunning,
      pauseAfterCurrent: false,
    },
  },
  "Batch started.",
);
if (started) {
  setDraft((current) => ({
    ...current,
    inputText: "",
    inputValidation: current.inputMode === "inline" ? null : current.inputValidation,
  }));
}
```

Do not save `inputText` in settings, refs, jobs, notices, errors, diagnostics, or output metadata.

- [ ] **Step 7: Render the paste/file selector and active control**

Replace the current input-file field with:

```tsx
<div className="account-keeper__field">
  <span className="account-keeper__field-label">Input source</span>
  <div className="account-keeper__source-modes" role="group" aria-label="Input source">
    {(["inline", "file"] as const).map((mode) => (
      <button
        key={mode}
        type="button"
        aria-pressed={draft.inputMode === mode}
        onClick={() => setDraft((current) => current.inputMode === mode
          ? current
          : { ...current, inputMode: mode, inputValidation: null })}
        disabled={busyAction !== null}
      >
        {mode === "inline" ? "Paste text" : "Choose file"}
      </button>
    ))}
  </div>

  {draft.inputMode === "inline" ? (
    <>
      <label htmlFor="account-keeper-input-text">Account input</label>
      <textarea
        id="account-keeper-input-text"
        value={draft.inputText}
        placeholder="owner@example.test|current-password|JBSWY3DPEHPK3PXP"
        autoComplete="off"
        spellCheck={false}
        disabled={busyAction !== null}
        onChange={(event) => setDraft((current) => ({
          ...current,
          inputText: event.target.value,
          inputValidation: null,
        }))}
      />
      <small>One account per line: account|current_password|totp_secret</small>
      <div className="account-keeper__input-actions">
        <button
          type="button"
          className="btn-ghost"
          onClick={() => void validateInput()}
          disabled={!draft.inputText.trim() || busyAction !== null}
        >
          Validate Input
        </button>
      </div>
    </>
  ) : (
    <>
      <label htmlFor="account-keeper-input-file">Input file</label>
      <div className="account-keeper__picker">
        <input id="account-keeper-input-file" value={draft.inputPath} placeholder="Choose a local text file" readOnly />
        <button
          type="button"
          className="btn-ghost"
          aria-label="Choose input file"
          onClick={() => void chooseInput()}
          disabled={busyAction !== null}
        >
          Browse
        </button>
      </div>
    </>
  )}

  {draft.inputValidation && (
    <div className={`account-keeper__validation ${draft.inputValidation.validCount > 0 ? "is-valid" : "is-invalid"}`}>
      <strong>{draft.inputValidation.validCount > 0 ? "Input valid" : "Input needs attention"}</strong>
      <span>{draft.inputValidation.validCount} accounts</span>
      <span>{draft.inputValidation.maskedAccounts.slice(0, 3).join(", ")}</span>
    </div>
  )}
</div>
```

Keep the template field outside this conditional and enabled whenever no action is running.

Use dynamic acknowledgment copy:

```tsx
<span>
  {draft.inputMode === "inline"
    ? "I understand pasted input and the output file contain plaintext secrets"
    : "I understand the selected input and output files contain plaintext secrets"}
</span>
```

- [ ] **Step 8: Style new controls without changing global form rules**

Add to `AccountKeeper.css` near existing field styles:

```css
.account-keeper .account-keeper__field-label,
.account-keeper .account-keeper__field > small {
  color: var(--tx-3);
  font-size: 10.5px;
}

.account-keeper .account-keeper__source-modes {
  display: inline-grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 4px;
  width: min(260px, 100%);
  padding: 3px;
  border: 1px solid var(--bd-1);
  border-radius: 8px;
  background: var(--bg-1);
}

.account-keeper .account-keeper__source-modes button {
  min-height: 30px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--tx-3);
}

.account-keeper .account-keeper__source-modes button[aria-pressed="true"] {
  background: var(--accent-dim);
  color: var(--accent-hi);
}

.account-keeper .account-keeper__field textarea {
  min-height: 112px;
  font-family: "JetBrains Mono", "SF Mono", ui-monospace, monospace;
  font-size: 11.5px;
}

.account-keeper .account-keeper__input-actions {
  display: flex;
  justify-content: flex-end;
}
```

- [ ] **Step 9: Run component and frontend tests and confirm GREEN**

Run:

```powershell
npm.cmd test -- src/account-keeper/model.test.ts src/account-keeper/AccountKeeper.test.tsx
npm.cmd run build
```

Expected: model/component tests pass; TypeScript and Vite production build pass.

- [ ] **Step 10: Commit UI and IPC changes**

```powershell
git add -- src/account-keeper/types.ts src/account-keeper/model.ts src/account-keeper/model.test.ts src/account-keeper/AccountKeeper.tsx src/account-keeper/AccountKeeper.css src/account-keeper/AccountKeeper.test.tsx
git commit -m "feat(account-keeper): add pasted input UI"
```

### Task 5: Exercise Inline Start And File Profile Reuse In Tauri QA

**Files:**
- Modify: `automation/qa/account-keeper-tauri-qa.mjs:19-99`
- Modify: `automation/qa/account-keeper-tauri-qa.mjs:100-121`
- Modify: `automation/qa/account-keeper-tauri-qa.mjs:215-248`
- Modify: `src/account-keeper/AccountKeeper.tsx:179-230`
- Test: `src/account-keeper/AccountKeeper.test.tsx:127-167`

- [ ] **Step 1: Make the QA bridge test fail on tagged configuration**

Update the component dev-bridge test to provide:

```typescript
document.documentElement.dataset.accountKeeperQaConfig = JSON.stringify({
  source: {
    kind: "inline",
    text: "owner@example.test|current-password|JBSWY3DPEHPK3PXP",
  },
  outputPath: "C:\\fixtures\\result.json",
  templateText: "Local-{random:16}",
  adapterId: "fixture-v1",
});
```

After dispatch, assert the dataset secret is removed:

```typescript
await waitFor(() => expect(document.documentElement.dataset.accountKeeperQaConfig).toBeUndefined());
```

Run:

```powershell
npm.cmd test -- src/account-keeper/AccountKeeper.test.tsx
```

Expected: RED until the QA bridge changes from `inputPath` to `source` and deletes its configuration string.

- [ ] **Step 2: Change first QA batch to inline and later batches to files**

Replace first-batch setup with:

```javascript
const firstInputText = inputRecord(initialPassword);
const firstOutput = path.join(filesRoot, "result-1.json");

({ tauri, browser } = await startAndConnect());
page = await openAccountKeeper(browser);
await configureBatch(page, { kind: "inline", text: firstInputText }, firstOutput);
await startBatch(page);
await waitFor(
  () => page.getByLabel("Account input", { exact: true }).inputValue().then((value) => value === ""),
  30_000,
  "Pasted input stayed in React state after start",
);
```

Keep second and third batches as real UTF-8 files:

```javascript
const secondInput = path.join(filesRoot, "batch-2.txt");
const secondOutput = path.join(filesRoot, "result-2.json");
await writeInput(secondInput, firstAccount.password);
await configureBatch(page, { kind: "file", path: secondInput }, secondOutput);

const thirdInput = path.join(filesRoot, "batch-3.txt");
const thirdOutput = path.join(filesRoot, "result-3.json");
await writeInput(thirdInput, secondResult.accounts[0].password);
await configureBatch(page, { kind: "file", path: thirdInput }, thirdOutput);
```

Add a shared synthetic record builder:

```javascript
function inputRecord(password) {
  return `${syntheticAccount}|${password}|${totpSecret}\n`;
}

async function writeInput(filePath, password) {
  await writeFile(filePath, inputRecord(password), "utf8");
}
```

- [ ] **Step 3: Make QA configuration source-aware**

Replace `configureBatch` with:

```javascript
async function configureBatch(page, source, outputPath) {
  await page.waitForFunction(
    () => document.documentElement.dataset.accountKeeperQaStatus === "idle",
  );
  await page.evaluate(({ inputSource, outputPath: output, templateText }) => {
    document.documentElement.dataset.accountKeeperQaConfig = JSON.stringify({
      source: inputSource,
      outputPath: output,
      templateText,
      adapterId: "fixture-v1",
    });
    delete document.documentElement.dataset.accountKeeperQaStatus;
    document.documentElement.dispatchEvent(new Event("account-keeper:qa-configure"));
  }, { inputSource: source, outputPath, templateText: template });
  await page.waitForFunction(() => document.documentElement.dataset.accountKeeperQaStatus === "ready");
  await page.evaluate(() => {
    document.documentElement.dataset.accountKeeperQaStatus = "idle";
  });
  const acknowledgement = source.kind === "inline"
    ? "I understand pasted input and the output file contain plaintext secrets"
    : "I understand the selected input and output files contain plaintext secrets";
  await page.getByLabel(acknowledgement, { exact: true }).check();
  await page.getByRole("button", { name: "Start Batch", exact: true }).waitFor({ state: "visible" });
}
```

- [ ] **Step 4: Prevent failure diagnostics from printing credentials**

Add:

```javascript
function assertRedactedPayload(value, label) {
  const serialized = JSON.stringify(value);
  for (const forbidden of [syntheticAccount, initialPassword, totpSecret]) {
    assert.equal(serialized.includes(forbidden), false, `${label} exposed a protected fixture value`);
  }
}
```

Use it before diagnostics are written:

```javascript
} catch (error) {
  const diagnostics = await collectFailureDiagnostics(page);
  assertRedactedPayload(diagnostics, "QA diagnostics");
  process.stderr.write(`Account Keeper QA diagnostics: ${JSON.stringify(diagnostics)}\n`);
  throw error;
}
```

Keep `assertLogsAreRedacted(allLogs)` and the restart/manual-state assertions. Change its assertion message to `QA log exposed a protected fixture value` so a failed redaction test does not print the fixture credential.

- [ ] **Step 5: Run component bridge test and Tauri QA**

Run:

```powershell
npm.cmd test -- src/account-keeper/AccountKeeper.test.tsx
npm.cmd run build:account-keeper-worker
npm.cmd run qa:account-keeper-tauri
```

Expected final QA JSON contains:

```json
{"status":"passed","profile_reuse":true,"manual_preserved":true}
```

The real JSON also includes batch and profile identifiers. If `worker_not_ready` recurs, stop this task and invoke `superpowers:systematic-debugging`; do not weaken assertions, retry blindly, or read plaintext input/output files for diagnosis.

- [ ] **Step 6: Commit QA coverage**

```powershell
git add -- automation/qa/account-keeper-tauri-qa.mjs src/account-keeper/AccountKeeper.tsx src/account-keeper/AccountKeeper.test.tsx
git commit -m "test(account-keeper): cover inline input"
```

### Task 6: Update Usage Docs And Run Full Verification

**Files:**
- Modify: `docs/account-keeper.md:127-141`
- Modify: `docs/account-keeper.md:294-308`
- Modify: `docs/account-keeper.vn.md:123-137`
- Modify: `docs/account-keeper.vn.md:286-300`

- [ ] **Step 1: Update English batch instructions**

Replace the start sequence with:

```markdown
1. Open **Account Keeper** in BrProxies.
2. Keep **Paste text** selected and paste one record per line, or select
   **Choose file** and browse to a UTF-8 plaintext input file.
3. Click **Validate Input** for pasted text. File input validates after selection.
4. Choose the plaintext output JSON path.
5. Enter and validate the batch password template.
6. Review the masked account count and any line-specific errors.
7. Acknowledge that the active input source and output contain plaintext secrets.
8. Optionally enable **Keep profile running after completion**.
9. Click **Start Batch** and confirm the password-changing operation.
```

Replace the UI-boundary paragraph with:

```markdown
Pasted input is sent once through local React-to-Tauri IPC and parsed in memory;
Account Keeper does not create a temporary plaintext input file. File mode sends
only the selected path. The UI receives masked account identifiers, profile IDs,
stages, attempts, timestamps, and redacted errors. After a successful start, the
component drops its pasted-text reference; this is reference clearing, not a
memory-zeroization guarantee.
```

Add to output/security rules:

```markdown
- Pasted input is not stored in settings, checkpoints, jobs, events, logs,
  diagnostics, or output metadata.
- Switching input modes preserves the unsent draft values but clears stale
  validation; a successful start clears the pasted draft.
```

- [ ] **Step 2: Mirror the same behavior in Vietnamese**

Use this start sequence:

```markdown
1. Mở **Account Keeper** trong BrProxies.
2. Giữ **Paste text** để dán mỗi account trên một dòng, hoặc chọn
   **Choose file** rồi chọn file input plaintext UTF-8.
3. Bấm **Validate Input** với text đã dán. File được validate ngay sau khi chọn.
4. Chọn đường dẫn output JSON plaintext.
5. Nhập và validate password template cho batch.
6. Kiểm tra số account đã mask và lỗi theo dòng.
7. Xác nhận source input đang dùng và output chứa plaintext secrets.
8. Tùy chọn bật **Keep profile running after completion**.
9. Bấm **Start Batch** và xác nhận thao tác đổi password.
```

Add this boundary text:

```markdown
Text đã dán chỉ đi qua IPC React-to-Tauri cục bộ một lần và được parse trong RAM;
Account Keeper không tạo file input plaintext tạm. File mode chỉ gửi đường dẫn đã
chọn. Sau khi start thành công, component bỏ reference tới text đã dán; thao tác
này không được xem là bảo đảm zeroize bộ nhớ.
```

Add matching bullets stating that pasted text never enters settings, checkpoints, jobs, events, logs, diagnostics, or output metadata.

- [ ] **Step 3: Verify docs contain no unfinished markers or real credentials**

Run:

```powershell
rg -n "T[B]D|T[O]DO|implement l[a]ter|fill in d[e]tails|similar to t[a]sk" docs/superpowers/plans/2026-07-30-account-keeper-inline-input.md docs/account-keeper.md docs/account-keeper.vn.md
rg -n "owner@example\.test|admin@example\.test|JBSWY3DPEHPK3PXP" docs/account-keeper.md docs/account-keeper.vn.md
```

Expected: first command has no matches. Second command may match only synthetic examples already documented; no real account, password, or TOTP value appears.

- [ ] **Step 4: Commit documentation**

```powershell
git add -- docs/account-keeper.md docs/account-keeper.vn.md
git commit -m "docs(account-keeper): document input modes"
```

- [ ] **Step 5: Run full focused verification**

Run in order:

```powershell
cargo fmt --manifest-path src-tauri\Cargo.toml -- --check
cargo test --manifest-path src-tauri\Cargo.toml account_keeper::tests -- --nocapture
cargo test --manifest-path src-tauri\Cargo.toml account_keeper_format::tests -- --nocapture
npm.cmd test
npm.cmd run build
npm.cmd run build:account-keeper-worker
npm.cmd run qa:account-keeper-tauri
npm.cmd run tauri build
git diff --check
git status --short --branch
```

Expected:

- Rust Account Keeper and parser tests pass.
- All Vitest tests pass.
- TypeScript/Vite production build passes.
- Worker resources stage successfully.
- Tauri QA reports inline success, file profile reuse, redacted logs/diagnostics, and preserved manual state.
- Windows release build completes and bundles Account Keeper resources.
- `git diff --check` prints nothing.
- `git status` shows only intentional feature changes plus pre-existing unrelated dirty files.

Do not stage or revert `android_manager/android_manager/api.py`, `dump.rdb`, `smart launch/smart-build.ps1`, `smart launch/test-smart-build-lock.ps1`, `src-tauri/src/lib.rs`, `src-tauri/src/runtime.rs`, `src/App.tsx`, or `src-tauri/src/actions.rs` unless a later user request explicitly changes their scope.

- [ ] **Step 6: Review final diff against the approved spec**

Run:

```powershell
git diff -- src-tauri/src/account_keeper.rs src/account-keeper/types.ts src/account-keeper/model.ts src/account-keeper/model.test.ts src/account-keeper/AccountKeeper.tsx src/account-keeper/AccountKeeper.css src/account-keeper/AccountKeeper.test.tsx automation/qa/account-keeper-tauri-qa.mjs docs/account-keeper.md docs/account-keeper.vn.md
```

Confirm all acceptance points:

- Paste mode is default; file mode still works.
- Both modes use `{ kind, text|path }`, one parser, and one 16 MiB limit.
- Only active source is validated/submitted.
- Switching modes preserves drafts and clears validation.
- Template remains independently editable.
- Successful start clears `inputText`.
- No source text enters checkpoints, views, events, logs, diagnostics, or output metadata.
- Vault/checkpoint schemas and resume behavior are unchanged.
- No token, cookie, session, authorization-header, or mailbox automation was added.
