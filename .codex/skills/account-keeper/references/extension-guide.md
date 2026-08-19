# Extension Guide

Keep future changes modular. Update the smallest reference and code owner that represents the new behavior.

## Add Or Change A Provider Adapter

1. Define the provider's allowed origins and authentication states.
2. Implement page classification without credential side effects.
3. Implement direct login, TOTP/manual challenge handling, password settings navigation, password submission, logout, and signed-in verification.
4. Add synthetic adapter/flow tests for signed-out and already-signed-in profiles.
5. Register the adapter without adding provider-specific branches to the generic flow unless the protocol truly differs.
6. Update `architecture.md` and `debugging.md` only for durable behavior.

For authenticator enrollment adapters:

- Read secrets only from visible enrollment UI; reveal the manual setup key when the QR-only dialog hides it.
- Treat a visible enrollment error or still-open OTP dialog as failure even when a background toggle appears enabled.
- Require the enrollment dialog to close before toggle- or disable-control-based success.
- Add localized tests for manual-secret reveal labels and rejected-code messages.
- Rebuild and hash-check every worker bundle before live verification.

For authenticator enrollment adapters:

- Read secrets only from visible enrollment UI; reveal the manual setup key when the QR-only dialog hides it.
- Treat a visible enrollment error or still-open OTP dialog as failure even when a background toggle appears enabled.
- Require the enrollment dialog to close before toggle- or disable-control-based success.
- Add localized tests for manual-secret reveal labels and rejected-code messages.
- Rebuild and hash-check every worker bundle before live verification.

## Add A Stage, Command, Or Failure Code

Keep these layers synchronized:

- `automation/account-keeper-protocol.mjs` schema and sanitization.
- Worker emission/command handling.
- Rust worker-message parsing and state transition handling.
- Store/checkpoint/output representation when persisted.
- React types, model, labels, and controls.
- Node, Rust, and React tests.
- English and Vietnamese documentation.

## Change Output Schema

- Introduce an explicit schema-version migration strategy.
- Preserve atomic writes and secret-bearing classification.
- Keep old checkpoints resumable or fail with a clear non-secret migration error.
- Update Rust serialization tests and documentation examples using synthetic values only.
- Never add telemetry, diagnostic copies, or plaintext backups.

## Change Password-State Semantics

Treat this as a safety-critical change. Update invariants, cancellation boundaries, resume behavior, output rules, UI warnings, and all cross-language tests together.

## Maintain This Skill

- Keep `SKILL.md` as routing, invariants, and the short workflow.
- Put durable technical detail in `references/`.
- Add a new reference only when the topic is independently useful; otherwise extend the closest existing file.
- Keep commands executable on Windows PowerShell and use `npm.cmd`.
- Validate after every edit:

```powershell
python C:\Users\admin\.codex\skills\.system\skill-creator\scripts\quick_validate.py .codex\skills\account-keeper
git diff --check
```
