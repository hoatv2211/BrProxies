# Live Account Safety

Use live verification only when the operator supplied or selected an authorized account and explicitly requested a real run.

## Before The Run

- Confirm synthetic worker tests and relevant Rust tests pass.
- Confirm the target uses a persistent mapped BrProxies profile.
- Confirm `account-keeper-result.json` is ignored and not tracked.
- Do not echo the selected record, password, TOTP secret, or generated password.
- Avoid screenshots while any credential field, account identifier, TOTP code, or recovery content is visible.
- Keep the run to one target account unless the operator explicitly requests a batch.

## During The Run

- If already signed in, navigate directly to Settings, Security and login, Password.
- Do not log out before the password-change attempt.
- Do not select Forgot Password when the signed-in password control is available.
- Stop for manual CAPTCHA, email verification, device approval, or security challenge.
- Do not access the operator's inbox or extract recovery links.
- Stop immediately on unknown credential state; do not retry old and new passwords speculatively.

## After The Run

A successful live result requires all of these:

- The provider accepted the password change.
- The worker logged out after the change.
- Direct login with the new password succeeded.
- Authenticated state verification succeeded.
- The target output record has `status: success`.
- The target output record has `password_state: changed`.
- `last_verified_at` is present and updated.

Inspect only those metadata fields. Do not paste the complete record into the response.

## Output Update Rules

- Prefer the Rust coordinator's normal vault/checkpoint/output transaction.
- Never hand-edit a result to claim success before browser verification.
- If a narrowly scoped repair requires a manual output update after independently verified success, preserve schema version, batch metadata, account mapping, password, TOTP, and profile fields; update only the verified state fields and use an atomic replace.
- Never downgrade `password_state: unknown` without operator recovery establishing which credential is valid.

## Reporting

Report only:

- Whether the password change and new-password login were verified.
- Whether output metadata is `success/changed`.
- Which automated checks passed.
- Any manual action still required.

Do not report account identifiers, passwords, TOTP values, cookies, tokens, or secret file contents.

