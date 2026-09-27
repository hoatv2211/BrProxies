# BrProxies Bridge Chrome Extension

[Hướng dẫn tiếng Việt](README.vn.md)

Manifest V3 extension with three local tools:

- Connect verified Account Keeper profiles to Codex OAuth and export 9Router or Cockpit JSON.
- Convert existing Cockpit JSON to 9Router JSON and back without uploading it.
- Use a local BrProxies ProxyPool proxy in Chrome.

## Auto-load for a BrProxies profile

This is the recommended way to use the extension with BrProxies Browser:

1. Open **Browsers** in BrProxies.
2. Create a profile or click **Edit** on an existing profile.
3. Under **Browser extensions > BrProxies Bridge**, choose
   **Include and auto-load**.
4. Save the profile, then stop and start it again if it is already running.

The choice is stored per profile. BrProxies loads the bundled extension on
normal interactive launches, so Chrome's **Load unpacked** flow is not needed.
Automation/CDP launches continue to disable browser extensions to keep Account
Keeper flows isolated.

If an older unpacked Bridge exists at another location, auto-load stops with a
migration message instead of adding a duplicate. Disable Bridge auto-load for
that profile, launch it and remove the old Bridge at `chrome://extensions`.
Close the profile, enable auto-load again, and relaunch. Other extensions and
external extension folders are not modified.

## Load locally (manual fallback)

1. Build and run BrProxies with `smart launch\run.bat`.
2. Open Chrome `chrome://extensions`.
3. Enable `Developer mode`.
4. Click `Load unpacked` and choose this `extension` folder.

Choose the directory that directly contains `manifest.json`. Do not choose
`src-tauri/target/release/bundle`; that directory contains installers, not an
unpacked Chrome extension.

## Export Codex JSON

### Chrome current-session pairing (0.3.1)

Run the updated BrProxies app with Automation API enabled. In any regular Chrome
window, open ChatGPT, enable **Use current ChatGPT session**, and press
**Connect & Export** directly. No Bearer token or Connect BrProxies step is needed.
Compare the eight-character code on the extension flow page with the native
BrProxies approval dialog; approve only your own request. Then approve your
account on the OpenAI OAuth page. This mode ignores managed profile selections.
The one-shot permission expires after 10 minutes and cannot read profiles/cookies.
BrProxies must remain running; this is not standalone offline OAuth.
If pairing is denied, you can retry immediately with a new approval request.
If a pending or approved pairing is abandoned, wait up to 10 minutes before retrying.
For managed-profile export, turn current-session mode off and use the token flow below.

1. In BrProxies, enable **Settings > Automation API** and restart the app if
   the setting changed.
2. Copy the **Bearer token** from the same Settings card.
3. Open the extension, select **Codex Export**, paste the Bearer token, and
   click **Connect BrProxies**.
4. Select one or more profiles, or leave the list unselected when using the
   current ChatGPT session, choose **9Router** or **Cockpit**, and click
   **Connect & Export**.
5. Leave **Use current ChatGPT session** enabled when the same Chrome window
   already has the matching ChatGPT account signed in. The extension checks for
   a `chatgpt.com` or `chat.openai.com` tab, then opens the official OpenAI OAuth
   page in that Chrome profile. It does not read cookies, local storage, or raw
   browser tokens.
6. If an OpenAI authorization tab opens, approve access. With no profile selected,
   the returned account is exported directly from this browser session; with
   profiles selected, the account must match the selected verified profile.

The extension calls only the loopback Automation API at
`http://127.0.0.1:40325` or `http://localhost:40325`. The Bearer token is kept
in `chrome.storage.session`, not persistent local storage. BrProxies reads the
Codex credential from its DPAPI-protected vault and refreshes it when needed.
The extension never reads ChatGPT cookies or extracts tokens from web pages;
it only opens the official OAuth authorization URL and polls redacted status.

The downloaded JSON contains plaintext OAuth credentials. Import it promptly,
store it securely, and delete copies that are no longer needed.

## Convert Cockpit and 9Router JSON

1. Open the extension and select **JSON Convert**.
2. Choose **Cockpit to 9Router** or **9Router to Cockpit**.
3. Choose a JSON file or paste an account object, account array, or an object
   containing an `accounts` array.
4. Click **Convert & download**.

The converter runs entirely inside the popup. It does not call the BrProxies
API, does not upload JSON, and does not write credentials to Chrome storage.
After a successful download, the source text is cleared from the popup.

## Use ProxyPool

1. Open BrProxies > ProxyPool and collect/check until working rows exist.
2. Open the extension and select **ProxyPool**.
3. Keep the URL as `http://127.0.0.1:40326`, then click **Connect**.
4. Click **Test live**, choose **Use**, or click **Rotate**.
5. Click **Direct** to clear Chrome's proxy setting.

## Limits

- Automation API use is loopback-only; browser-session host permissions are limited
  to the official ChatGPT domains listed above.
- OAuth succeeds only when the account authorized in the current browser
  session matches the selected verified Account Keeper profile.
- If no signed-in ChatGPT tab is available, uncheck **Use current ChatGPT
  session** to keep the existing standalone OAuth flow.
- Username/password proxy authentication is not implemented.
- BrProxies and its local services must be running.
