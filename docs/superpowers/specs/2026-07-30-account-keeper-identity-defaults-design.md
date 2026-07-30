# Account Keeper Identity Challenge and Defaults Design

## Context

Account Keeper can reach OpenAI's password-reset journey but currently fails with
flow_changed when OpenAI inserts a current-password identity challenge before
showing the new-password form. The UI also requires unnecessary setup for the
password template and output path on every batch.

This design extends the existing Account Keeper design without changing its
credential-storage, operator-approval, or session-export boundaries.

## Goals

- Complete OpenAI's current-password identity challenge automatically.
- Reuse the existing local TOTP pipeline when the identity challenge requests MFA.
- Continue to the new-password form without operator action when no CAPTCHA or
  email verification is required.
- Pre-fill and validate safe Account Keeper defaults so the operator normally only
  provides account input.

## Non-Goals

- CAPTCHA solving or bypassing platform security controls.
- Automatic email inbox access or email-link verification.
- Removing the plaintext-secret acknowledgement before batch start.
- Exporting browser cookies, access tokens, refresh tokens, or sessions.

## Identity Challenge Flow

The password-change phase receives a contextual identity_challenge state when the
reset journey shows a visible current-password input. This state is separate from
normal login so the worker cannot accidentally restart the login flow.

The worker performs the following sequence:

1. Open the supported password-reset journey.
2. If a current-password identity challenge appears, submit the stored current
   password once.
3. Wait for the identity form to leave before classifying the next state.
4. If TOTP is requested, use the existing totp_required protocol and local TOTP
   generator, with the existing two-attempt limit.
5. If the new-password form appears, continue through the existing explicit
   password-submit authorization and password verification flow.
6. If CAPTCHA, email verification, or an unknown security challenge appears, enter
   waiting_manual and require operator resume.

Loop guards prevent submitting the identity password more than once without a
state transition. Repeated unchanged identity forms fail with the existing
password_change_failed code instead of looping.

## Adapter Boundary

The OpenAI adapter gains password-change-specific classification and submission:

- Distinguish a visible current-password challenge during the reset phase from a
  normal login form.
- Fill only the current-password input for identity verification.
- Click semantic submit controls so localized button text remains supported.
- Wait for the identity input to remain hidden before returning.

The generic login classifier remains unchanged for normal authentication.

## Default Form Configuration

When Account Keeper opens, the backend returns a local default configuration:

- Template: BrP@{random:16}!
- Output: the user's Documents directory plus account-keeper-result.json

The React screen loads these defaults once and immediately validates the template
with the existing backend validator. The validation result is displayed without
requiring **Validate Template** to be clicked.

Both fields remain editable:

- Editing the template clears its old validation result; the operator can run the
  existing validation action again.
- **Browse** can replace the default output path.
- Account input remains empty and operator-provided.
- Input validation and the plaintext-secret acknowledgement remain required.

The backend, not the frontend, resolves the Documents path so the default remains
correct across supported operating systems.

## API Shape

Add a Tauri command returning a small non-secret DTO with two string fields:

- template: BrP@{random:16}!
- outputPath: <Documents>/account-keeper-result.json

The command performs no filesystem write. The output file is created only when a
batch writes results.

## Testing

- Worker-flow test: identity password challenge transitions to new-password form.
- Worker-flow test: identity password challenge followed by TOTP uses the existing
  TOTP command protocol.
- Worker-flow test: unchanged repeated identity challenge fails without looping.
- Adapter test: localized semantic submit works for the identity password form.
- UI test: default template and output path load automatically.
- UI test: default template validation appears automatically.
- UI test: operator edits still clear/re-run validation and Browse still overrides
  the output path.
- Backend test: default output path uses the platform Documents directory.

## Acceptance Criteria

- The observed OpenAI identity challenge no longer ends as flow_changed.
- Password and optional TOTP identity verification complete automatically.
- CAPTCHA and email verification still require manual intervention.
- A newly opened Account Keeper screen shows a validated BrP@{random:16}! template
  and a Documents output path.
- The operator can start normal preparation by entering and validating input,
  acknowledging plaintext handling, and starting the batch.
- Existing automation, frontend, Rust, and smart release-build checks pass.
