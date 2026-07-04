# Smart Build Design

## Goal

Make `smart launch\build.bat` faster for repeated local builds while keeping a reliable full build path.

## Design

`build.bat` remains the entrypoint. By default it delegates to a PowerShell helper that computes hashes for dependency files, frontend inputs, Android Manager dependency metadata, and Tauri/Rust inputs. Hashes are stored under `.brproxies-build-cache`.

The smart build skips expensive dependency setup when inputs are unchanged:

- npm install runs only when `node_modules` is missing, package files changed, `/deps` is passed, or `/full` is passed.
- Android Manager editable install runs only when the venv is missing, `android_manager\pyproject.toml` changed, `/deps` is passed, or `/full` is passed.
- frontend build is delegated to `npm.cmd run tauri build -- --no-bundle` so the release exe embeds assets correctly.
- desktop exe build runs only when Rust/Tauri inputs changed, frontend inputs changed, the exe is missing, the smart build helper changed, or `/full` is passed.

`/full` preserves the current dependable behavior by forcing every step. `/deps` refreshes dependency setup without forcing source rebuilds.

## Commands

```bat
smart launch\build.bat
smart launch\build.bat /full
smart launch\build.bat /deps
```

## Error Handling

Missing Cargo, rustc, npm, or Python fails with a clear message. Any failed command stops the script and returns a non-zero exit code. Cache hashes are written only after the matching step succeeds.

## Testing

Validate help output, PowerShell syntax, and a smart build run. A first build may still be slow; repeated runs should skip unchanged steps.
