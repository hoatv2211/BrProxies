# Operator Workflow

Use this runbook when the operator wants to provide Account Keeper records and have the agent run the complete workflow and produce the result file.

## Input Contract

- Receive a local file path, not plaintext credentials in chat.
- Each non-empty line uses `account|current_password|totp_secret`.
- Keep the input file outside Git or under an ignored path.
- Validate shape locally without printing account, password, or TOTP values.
- Default to one live record per run. Use batches only when explicitly requested.

Example invocation without secrets:

```text
$account-keeper chạy file C:\private\account-keeper-input.txt và tự ghi output
```

## Autonomous Run

1. Confirm focused Node and Rust tests pass after any code change.
2. Rebuild worker resources and restart BrProxies so the running app cannot use a stale adapter bundle.
3. Open Account Keeper and select the supplied local input file.
4. Keep the default output at `%USERPROFILE%\Documents\account-keeper-result.json` unless the operator names another path.
5. Start the job and monitor only redacted stages and failure codes.
6. Reuse the persistent mapped profile. If it is already signed in, navigate directly to Settings, Security and login, Password.
7. If an expired-session overlay appears, use its login flow and adopt the allowed-origin auth popup before classifying or submitting credentials.
8. Treat `flow_changed` immediately after a login-password submit as a transient navigation state and wait for the next supported surface.
9. Submit the current-password identity challenge when the provider requires it, then complete password change, logout, and new-password verification.
10. Stop for CAPTCHA, email verification, device approval, unusual-login approval, or an unknown security challenge.
11. Stop repeated live retries when the same `flow_changed` or `navigation_failed` result persists; keep `password_state: unknown` and preserve the profile.
12. On verified login, let Rust atomically update vault, checkpoint, and output.
13. Confirm output metadata is `status: success`, `password_state: changed`, with `last_verified_at` present.

## Output Contract

- Never paste the full output JSON into chat.
- Report only whether password change and new-password login were verified.
- Report the output path and terminal metadata without account identifiers.
- Keep the output ignored and untracked.
- Do not retry a `credential_state_unknown` account. Preserve the profile for manual recovery.

## Supported Operator Requests

- `chạy account keeper từ file <path>`
- `đổi password account trong file và tự output`
- `resume job account keeper`
- `kiểm tra output account keeper`
- `thêm provider/state mới vào workflow`
