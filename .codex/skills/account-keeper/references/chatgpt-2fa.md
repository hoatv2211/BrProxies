# ChatGPT Authenticator 2FA Runbook

Last updated: **2026-08-19**.

Use this runbook for `change_totp`, a stuck `auth.openai.com/mfa-challenge`, or recovery after a partially completed ChatGPT authenticator rotation.

## Safety Invariant

Keep one signed-in persistent profile open for the entire mutation:

```text
old factor enabled
-> authorize and complete removal
-> open new enrollment immediately
-> verify a code from the new secret
-> confirm authenticator enabled
-> commit vault + Notes + checkpoint + output
```

Never log out between disable and new-factor verification. After disable authorization, any uncertain state is critical until live inspection establishes the active factor.

## Provider State Machine

| State | Surface | Allowed next action |
| --- | --- | --- |
| `enabled` | ChatGPT Security settings | Begin disable once |
| `confirmation` | ChatGPT modal | Confirm removal |
| `identity_challenge` | `auth.openai.com/log-in/password` | Submit current password once |
| `totp_required` / `totp_rejected` | `auth.openai.com/mfa-challenge/...` | Submit a fresh old-factor code, maximum two attempts |
| `signed_in` | ChatGPT shell after redirect | Reopen Security and reclassify |
| `disabled` | Authenticator switch off | Open enrollment immediately |
| `enrollment` | ChatGPT enrollment dialog | Read and verify the new secret |

Support both observed removal orders:

1. `identity_challenge -> totp_required -> confirmation`.
2. `confirmation -> identity_challenge -> totp_required`.

Use the current page from `pageSession` before every read and side effect. Search current and newer allowed-origin pages first; exclude stale older MFA tabs.

## Normal Rotation

1. Run focused synthetic tests and rebuild worker resources.
2. Verify the running debug/release app uses the rebuilt adapter.
3. Discover the profile's current CDP endpoint. Chromium may use `--remote-debugging-port=0`; never assume an earlier port.
4. Classify the existing ChatGPT page before opening login and preserve `signed_in` sessions.
5. Open **Settings -> Security and login**, inspect the authenticator switch, and emit `totp_disable_required` before the first destructive click.
6. Resolve removal challenges in the provider's actual order, reacquiring the page after every navigation.
7. Require `disabled` or an already-open `enrollment` surface before continuing.
8. Open enrollment immediately without logging out.
9. Read the provider-generated Base32 secret without logging it; send it only through `totp_enrollment_secret`.
10. Let Rust generate the enrollment code from that new secret and submit it to the visible form.
11. Verify the dialog closes and the authenticator switch or disable control reports enabled.
12. Only then emit `totp_changed` and `verified`; Rust replaces the stored secret and persists all surfaces.

## Stuck Challenge Diagnosis

Collect only safe metadata: current CDP reachability, page origins/paths, adapter state, switch checked state, dialog presence, worker count, bundle/source hash equality, terminal statuses, and boolean equality between secret stores.

Prioritize these root causes:

1. The worker keeps requesting codes while the submitted TOTP form has not transitioned.
2. The provider reordered confirmation, identity, and old-factor TOTP phases.
3. The flow follows a stale page or stale auth tab.
4. The running debug bundle is older than `automation/` or packaged resources.
5. Browser/output contain the verified new secret while vault or profile Notes still contain the old secret, so Rust generates the wrong code.

Never print page text, input values, profile Notes, secrets, codes, cookies, or complete JSON records.

## Persistence Drift Recovery

1. Stop only the orphan Account Keeper worker; keep Chromium and the mapped profile open.
2. Connect to the current CDP endpoint and inspect ChatGPT Security read-only.
3. Compare output, vault, pending change, and profile Notes by boolean equality or hashes.
4. If a candidate new secret may already be active, prove it non-destructively: open disable, complete password identity, submit one fresh candidate code, require the delete-confirmation surface, click **Cancel**, then confirm the switch remains enabled.
5. When the proof succeeds, treat browser state as authoritative and do not rotate again.
6. Prefer coordinator completion. If it cannot resume, use the narrow repair permitted by `live-account-safety.md`: atomically align vault, profile Notes, checkpoint, and output; clear only the stale error; refresh `last_verified_at`; preserve credentials, schema, account mapping, and profile.
7. Re-read every store and confirm equality, `status: success`, completed checkpoint, fresh verification time, zero orphan workers, and an open signed-in profile.

## Secret Handling

- Prefer an ignored local input file or the provider-owned enrollment DOM.
- If a secret was pasted into chat, never repeat it in commentary, commands, screenshots, logs, diffs, or fixtures.
- Never depend on public TOTP helper sites; close any such tab after recovery.
- Keep generated codes in memory and submit them only to the visible expected form.
- Wait for a fresh 30-second window before retrying and stop after two rejected attempts.

## Completion Gate

- ChatGPT remains signed in and authenticator 2FA is visibly enabled.
- A code derived from the new secret was accepted.
- No delete confirmation or stale MFA challenge remains active.
- Vault, profile Notes, checkpoint, and output agree on the new secret.
- Output has `status: success`, the correct password state for the operation, and fresh `last_verified_at`.
- Node tests, Rust tests, worker packaging, bundle hash checks, credential scan, and `git diff --check` pass.
