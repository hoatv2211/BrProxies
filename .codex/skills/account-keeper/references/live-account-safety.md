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
- During `change_totp`, do not log out or leave the account between disabling the old authenticator and verifying the new one.
- Do not select Forgot Password when the signed-in password control is available.
- Stop for manual CAPTCHA, email verification, device approval, or security challenge.
- Do not access the operator's inbox or extract recovery links.
- Stop immediately on unknown credential state; do not retry old and new passwords speculatively.
- Do not retry old and candidate-new TOTP secrets blindly against an unchanged challenge.
- If a partial TOTP run may already have enabled the new factor, inspect and prove the active factor before another destructive click.

## After The Run

A successful live result requires all of these:

- The provider accepted the password change.
- The worker logged out after the change.
- Direct login with the new password succeeded.
- Authenticated state verification succeeded.
- The target output record has `status: success`.
- The target output record has `password_state: changed`.
- `last_verified_at` is present and updated.

For `change_totp`, success instead requires all of these:

- The account remains signed in throughout removal and enrollment.
- The provider accepted a code generated from the new enrollment secret.
- The enrollment dialog is closed and authenticator 2FA is visibly enabled.
- No removal confirmation or stale MFA challenge remains active.
- Vault, profile Notes, checkpoint, and output agree on the verified secret.
- The output has `status: success` and fresh `last_verified_at`; password state remains appropriate for a non-password operation.

Inspect only those metadata fields. Do not paste the complete record into the response.

## Output Update Rules

- Prefer the Rust coordinator's normal vault/checkpoint/output transaction.
- Never hand-edit a result to claim success before browser verification.
- If a narrowly scoped repair requires a manual output update after independently verified success, preserve schema version, batch metadata, account mapping, password, TOTP, and profile fields; update only the verified state fields and use an atomic replace.
- A TOTP drift repair must update vault, profile Notes, checkpoint, and output together; repairing output alone leaves the next worker using the stale secret.
- Never downgrade `password_state: unknown` without operator recovery establishing which credential is valid.

## Reporting

Report only:

- Whether the password change and new-password login were verified.
- Whether a TOTP change kept the session open, accepted the new code, and left authenticator enabled.
- Whether output metadata matches the requested operation.
- Which automated checks passed.
- Any manual action still required.

Do not report account identifiers, passwords, TOTP values, cookies, tokens, or secret file contents.
