# Account Keeper Inline Input Design

## Status

Approved design for memory-only pasted input plus the existing local-file mode.

## Goal

Let operators start a batch by pasting account records or choosing a UTF-8 text file. Pasted credentials must never be written to a temporary plaintext file.

## Decisions

- `Paste text` is the default mode.
- `Choose file` preserves the current workflow.
- Both modes use the existing `parse_input` parser and masked validation DTO.
- Pasted text moves through local React-to-Tauri IPC and is parsed in memory.
- The password template remains editable before input or output selection.

## Non-Goals

- No temporary credential file.
- No pasted text in settings, checkpoints, job views, events, logs, diagnostics, or output metadata.
- No provider-flow, password-rotation, TOTP, profile-mapping, or resume changes.
- No cookie, session, authorization-header, access-token, or refresh-token export.

## User Experience

Batch setup adds `Paste text | Choose file`.

### Paste Text

- Show a multiline `Account input` textarea.
- Show `One account per line: account|current_password|totp_secret`.
- Use an explicit `Validate Input` button instead of validating every keystroke.
- Keep text only in component state until start, clear, or unmount.
- Clear the React reference immediately after a successful start request.

### Choose File

- Keep the read-only path field and `Browse` button.
- Selecting a file validates it immediately.

### Shared Behavior

- Switching modes preserves both draft values but clears stale validation.
- Only the active source is validated and submitted.
- Template validation and output selection remain independent.
- The plaintext acknowledgement text names pasted input or selected input file accurately.
- Start requires valid active input, template, output path, and acknowledgement.

## Frontend State

```ts
type InputMode = "inline" | "file";

interface DraftState {
  inputMode: InputMode;
  inputText: string;
  inputPath: string;
  // existing fields remain
}
```

Editing the active source or switching mode clears `inputValidation`.

## Tauri Contract

```ts
type InputSource =
  | { kind: "inline"; text: string }
  | { kind: "file"; path: string };
```

Validation receives `{ source: InputSource }`. Start replaces `inputPath` with `source` and keeps `outputPath`, `template`, `adapterId`, `keepProfileRunning`, and `pauseAfterCurrent`.

Serde uses `kind` as the discriminator. Empty, malformed, unknown, or mixed source payloads are rejected.

## Backend Flow

1. `inline`: reject UTF-8 payloads larger than 16 MiB, then call `parse_input(&text)`.
2. `file`: retain the 16 MiB metadata check, UTF-8 read, and parser call.
3. Return masked identities only during validation.
4. During start, merge parsed records into the DPAPI vault and checkpoint through the existing flow.
5. Drop the request source after initialization; never persist it.

The inline limit matches file mode and bounds local IPC memory usage.

## Security

- Never interpolate inline text into errors or logs.
- Validation errors expose line number and normalized category only.
- Progress events remain credential-free.
- Serialization tests prove inline text, passwords, and TOTP secrets are absent.
- Tests use synthetic `.test` accounts only.
- Clearing a JavaScript string removes the application reference but does not claim memory zeroization.

## Compatibility

- Existing file users retain their workflow.
- Vault and checkpoint formats need no migration.
- Resuming a job does not need the original source because credentials already reside in the DPAPI vault.
- The QA bridge keeps file support; normal UI QA adds inline coverage.

## Tests

### React

- Paste mode defaults on and accepts multiline input.
- Inline and file validation send only their active tagged source.
- Switching modes preserves values and clears validation.
- Template remains enabled.
- Successful start clears `inputText`.

### Rust

- Deserialize both source kinds.
- Reject empty, malformed, unknown, and oversized sources.
- Equivalent inline and file content parse identically.
- Preserve password-with-pipe parsing and redacted errors.
- Checkpoints and views contain no source text.

### Tauri QA

- Run one synthetic inline batch.
- Run a second file batch and verify profile reuse.
- Verify logs and diagnostics contain no input credentials.
- Preserve restart/manual-state assertions.

## Acceptance Criteria

- A batch can start from pasted records without an input file.
- File mode remains functional.
- Pasted input is never persisted as plaintext.
- Both modes share parsing, limits, masking, and redaction.
- Frontend, automation, Rust, release build, and Tauri QA pass.
