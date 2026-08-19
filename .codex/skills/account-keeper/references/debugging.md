# Debugging Guide

## Signed-In Profile Does Not Reach Password Screen

Expected behavior:

1. Classify the current page before forcing login navigation.
2. When state is `signed_in`, do not submit current credentials.
3. Open the account/profile menu.
4. Open **Settings**.
5. Select **Security and login** or the localized equivalent.
6. Open **Password** and classify the password-change form.

Check these failure points:

- `runAccountFlow()` always calls `openLogin()` before authentication.
- `openLogin()` redirects an authenticated profile instead of preserving the signed-in shell.
- `classify()` misses a valid signed-in state because an interstitial or session-expired dialog is present.
- Account-menu locators match a hidden or stale element.
- Settings opens as a modal and the adapter searches only the main page.
- Security tab or Password control text changed or is localized.
- The page changed during the action; use the current page from `pageSession` for each read/action.

Regression tests should prove both branches:

- Signed-out profile logs in, then opens password settings.
- Signed-in profile skips credential submission and opens password settings directly.

## Password Change And Verification

- Set the unknown-credential boundary immediately before the irreversible password-submit side effect.
- Emit `password_changed` only after the provider confirms the change action completed.
- Logout is part of post-change verification, not a prerequisite for entering password settings.
- Re-login must use `request.new_password`.
- `verifySignedIn()` must distinguish authenticated shell state from login, expired-session, or blocking interstitial state.
- Emit `verified` only after signed-in verification succeeds.

## TOTP And Manual Challenges

- Rust owns the TOTP secret and generates the short-lived six-digit code.
- Send a TOTP code only when the visible expected form requests it.
- Do not persist generated codes or expose the underlying secret to logs or protocol diagnostics.
- Pause at CAPTCHA, email verification, unusual-login approval, device approval, or unknown security challenge.
- The worker performs no browser side effects while waiting for manual continuation.

## ChatGPT 2FA Rotation Hangs

Load `chatgpt-2fa.md` when `change_totp` stalls on `mfa-challenge`, returns to `signed_in`, leaves a delete confirmation open, or reports `security_state_unknown` after the new authenticator appears enabled.

- Discover the current dynamic CDP listener instead of reconnecting to a stale port.
- Inspect active ChatGPT/auth pages read-only before starting another rotation.
- Distinguish removal confirmation, current-password identity, old-factor TOTP, disabled, enrollment, and enabled states.
- Verify source, packaged resources, and the debug bundle contain the same worker modules.
- Compare output, vault, pending security change, and profile Notes only by presence/equality metadata.
- If a candidate new secret is already active, verify it through a disable challenge and cancel the final removal. Do not enroll another factor.
- Repair persistence only after live proof, using atomic replacement and no plaintext backup.

## Failure Classification

- `invalid_credentials`: current direct-login credential rejected before password change.
- `unsupported_login_method`: social or external identity-provider login.
- `flow_changed`: expected provider surface or control no longer matches.
- `password_change_failed`: provider rejected or failed the password operation before a safe completion signal.
- `verification_failed`: proposed password could not be verified when the credential state is still known.
- `credential_state_unknown`: submission may have happened and neither credential is safely established.
- Repeated `flow_changed` during pending-password recovery: stop live retries, preserve the profile, and reproduce the page-selection/state transition with a synthetic test before another authorized attempt.
- `security_state_unknown`: a 2FA/email mutation crossed its irreversible boundary and remains critical until live inspection establishes the active security state.

Keep canonical failure messages in protocol/Rust mappings aligned. Do not leak arbitrary provider text when it may contain account data.

## Resume And Cancellation

- Never auto-resume a password-changing job after application restart.
- Resume only from explicit operator action and reconstructed safe state.
- Cancel before submission keeps `password_state: original`.
- Cancel after the submission boundary becomes critical/unknown.
- Abandon preserves persistent profile mapping and current recorded safety state.

## Locator Discipline

- Prefer roles and accessible names over CSS tied to generated classes.
- Support English and Vietnamese labels already used by the adapter.
- Require visibility before clicking; avoid first-match actions on hidden duplicates.
- Dismiss known post-login interstitials without treating them as authentication failure.
- Keep origin checks around provider-controlled actions, except intentional initial navigation.
