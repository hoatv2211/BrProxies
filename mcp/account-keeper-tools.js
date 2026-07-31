const JOB_FIELDS = [
  "id",
  "status",
  "batch_id",
  "stage",
  "error_code",
  "account_count",
  "has_last_verified_at",
  "created_at",
  "updated_at",
];

function redactJob(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return Object.fromEntries(
    JOB_FIELDS.filter((field) => Object.hasOwn(value, field)).map((field) => [field, value[field]]),
  );
}

function redactJobs(value) {
  return Array.isArray(value) ? value.map(redactJob).filter(Boolean) : [];
}

export function registerAccountKeeperTools(server, { api, text, z }) {
  server.tool(
    "account_keeper_create_job",
    "Queue an authorized Account Keeper password-change job using local input/output file paths only. Never pass credentials through MCP.",
    {
      input_path: z.string(),
      output_path: z.string().optional(),
      template: z.string().optional(),
      keep_profile_running: z.boolean().optional(),
      authorize_password_change: z.literal(true),
    },
    async ({ input_path, output_path, template, keep_profile_running, authorize_password_change }) =>
      text(redactJob(await api("/account-keeper/jobs", {
        method: "POST",
        body: {
          input_path,
          output_path,
          template,
          keep_profile_running,
          authorize_password_change,
        },
      }))),
  );

  server.tool(
    "account_keeper_list_jobs",
    "List redacted Account Keeper daemon jobs.",
    {},
    async () => text(redactJobs(await api("/account-keeper/jobs"))),
  );

  server.tool(
    "account_keeper_get_job",
    "Get redacted status for one Account Keeper daemon job.",
    { id: z.string() },
    async ({ id }) => text(redactJob(await api(`/account-keeper/jobs/${id}`))),
  );

  server.tool(
    "account_keeper_continue_job",
    "Continue a job after the operator manually completes the current security challenge.",
    { id: z.string() },
    async ({ id }) => text(redactJob(await api(`/account-keeper/jobs/${id}/continue`, { method: "POST" }))),
  );

  server.tool(
    "account_keeper_resume_job",
    "Explicitly resume a recovery_required job after BrProxies restarts.",
    { id: z.string() },
    async ({ id }) => text(redactJob(await api(`/account-keeper/jobs/${id}/resume`, { method: "POST" }))),
  );

  server.tool(
    "account_keeper_cancel_job",
    "Cancel a queued or active Account Keeper daemon job using the coordinator's password-state safety rules.",
    { id: z.string() },
    async ({ id }) => text(redactJob(await api(`/account-keeper/jobs/${id}/cancel`, { method: "POST" }))),
  );
}
