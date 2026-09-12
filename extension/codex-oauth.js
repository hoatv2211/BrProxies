const EXPORT_FORMATS = new Set(["nine_router", "cockpit"]);
const TERMINAL_OAUTH_STATUSES = new Set(["ready", "failed"]);

function uniqueProfileIds(profileIds) {
  return Array.from(
    new Set((Array.isArray(profileIds) ? profileIds : []).map(String).filter(Boolean))
  );
}

function report(onProgress, event) {
  if (typeof onProgress === "function") onProgress(event);
}

async function waitForOAuth({ operation, profile, readOAuth, sleep, now, timeoutMs, pollIntervalMs, onProgress }) {
  const deadline = now() + Math.min(
    timeoutMs,
    Math.max(1, Number(operation.expires_in_seconds || 300)) * 1000
  );
  let status = { status: "pending" };
  while (!TERMINAL_OAUTH_STATUSES.has(status.status) && now() < deadline) {
    await sleep(pollIntervalMs);
    status = await readOAuth(operation.operation_id);
    report(onProgress, { type: "oauth_status", profile, status: status.status });
  }
  if (status.status === "ready") return status;
  if (status.status === "failed") throw new Error(status.error_code || "codex_oauth_failed");
  throw new Error("codex_oauth_timed_out");
}

export async function connectAndExportCodex({
  profileIds,
  format,
  listProfiles,
  startOAuth,
  openAuthorization,
  readOAuth,
  exportAccounts,
  onProgress,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = () => Date.now(),
  timeoutMs = 360000,
  pollIntervalMs = 1000
}) {
  const selectedIds = uniqueProfileIds(profileIds);
  if (selectedIds.length === 0) throw new Error("Select at least one Codex profile");
  if (!EXPORT_FORMATS.has(format)) throw new Error("Unsupported Codex export format");

  const profiles = await listProfiles();
  const profilesById = new Map(
    (Array.isArray(profiles) ? profiles : []).map((profile) => [profile.profile_id, profile])
  );
  const selectedProfiles = selectedIds.map((profileId) => {
    const profile = profilesById.get(profileId);
    if (!profile) throw new Error("codex_profile_not_verified");
    return profile;
  });

  for (let index = 0; index < selectedProfiles.length; index += 1) {
    const profile = selectedProfiles[index];
    if (profile.codex_auth?.status === "ready") continue;
    report(onProgress, {
      type: "oauth_starting",
      profile,
      index,
      total: selectedProfiles.length
    });
    const operation = await startOAuth(profile.profile_id);
    await openAuthorization(operation.authorize_url);
    report(onProgress, {
      type: "oauth_opened",
      profile,
      index,
      total: selectedProfiles.length
    });
    await waitForOAuth({
      operation,
      profile,
      readOAuth,
      sleep,
      now,
      timeoutMs,
      pollIntervalMs,
      onProgress
    });
  }

  report(onProgress, { type: "exporting", total: selectedProfiles.length });
  return exportAccounts(selectedIds, format);
}
