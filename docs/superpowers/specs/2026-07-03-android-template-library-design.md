# Android Template Library Design

## Goal

Add an Android template library that feels like the existing Fingerprint Library, but stays metadata-only for the MVP. The user can press `Start manager` and get a usable default Android instance immediately, or choose a device template from `Library -> Android Templates` and create an instance from it.

## Scope

MVP includes:
- Built-in Android templates stored in the launcher UI code.
- Templates seeded from practical ReDroid defaults plus metadata inspired by Xiaomi device codenames and docker-android device names.
- A new `Library -> Android Templates` section with grouped cards.
- `Use ->` action that creates an Android instance through the existing Android Manager API.
- Auto-create default Android instance after `Start manager` when there are no instances.
- Settings toggle `Auto-create default Android after manager starts`, default enabled.

MVP excludes:
- Import/export custom Android templates.
- Kernel source usage from Xiaomi repositories.
- Running docker-android images as a second runtime.
- Deep Android anti-detect or build.prop spoofing.

## Design

Templates are frontend metadata:

```ts
type AndroidTemplate = {
  id: string;
  label: string;
  vendor: string;
  codename: string;
  androidVersion: string;
  runtime: "redroid" | "docker-android";
  image: string;
  deviceType: "phone" | "tablet";
  screen: string;
  source: "BrProxies" | "MiCode" | "docker-android";
  notes: string;
};
```

`redroid` templates create real manager instances with the selected image. `docker-android` templates are reference metadata in this phase; their cards are visible, but `Use ->` creates a ReDroid-compatible instance with the closest safe default image unless a future runtime is added.

## UI Flow

Android tab:
- `Start manager` starts the sidecar.
- If auto-create is enabled and `/instances` returns empty, the launcher posts `/instances` using default template metadata.
- The created instance appears in the table immediately after refresh.

Android Templates tab:
- Shows template groups by source/runtime.
- Cards show label, vendor/codename, Android version, image, screen, and runtime.
- `Use ->` starts the manager if needed, creates an instance from that template, then switches user to Android tab.

## Error Handling

- If Android Manager is not reachable, existing toast errors remain visible.
- If template create fails, the card action shows the API error.
- If auto-create fails, `Start manager` still counts as successful and the user sees the create error toast.

## Verification

- `npm.cmd run build` must pass.
- `python -m pytest android_manager\tests -q` must pass because Android Manager API remains compatible.
- `cargo check` in `src-tauri` must pass because settings schema changes touch Rust.

