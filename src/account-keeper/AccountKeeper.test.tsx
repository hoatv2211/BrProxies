import { StrictMode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountKeeper } from "./AccountKeeper";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
  unlisten: vi.fn(),
  open: vi.fn(),
  save: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: mocks.open, save: mocks.save }));

const inlineRecord = [
  "owner@example.test|current-password|JBSWY3DPEHPK3PXP",
  "admin@example.test|second-password|",
].join("\n");

const defaultTemplate = "BrP@{random:16}!";
const defaultOutputPath = "C:\\Users\\synthetic\\Documents\\account-keeper-result.json";

const failedJob = {
  batch_id: "job-failed",
  status: "failed",
  updated_at: "2026-07-31T03:03:40Z",
  output_path: defaultOutputPath,
  keep_profile_running: true,
  pause_after_current: false,
  accounts: [{
    account_key: "account-key",
    masked_account: "o***r@example.test",
    profile_id: "profile-1",
    stage: "failed",
    attempts: 1,
    updated_at: "2026-07-31T03:03:40Z",
    error_code: "flow_changed",
  }],
};

const managedProfile = {
  profile_id: "profile-1",
  masked_account: "o***r@example.test",
  status: "success",
  last_verified_at: "2026-07-31T03:00:00Z",
  running: false,
  import_payload: {
    schema_version: 1,
    kind: "brproxies-account-keeper-profile",
    profile_id: "profile-1",
    account_status: "success",
    last_verified_at: "2026-07-31T03:00:00Z",
    api_base_url: "http://127.0.0.1:40325",
    vault_ref: "account-keeper://vault/account-key",
  },
};

async function defaultInvoke(command: string) {
  if (command === "account_keeper_defaults") {
    return { template: defaultTemplate, outputPath: defaultOutputPath };
  }
  if (command === "account_keeper_list_jobs") return [];
  if (command === "account_keeper_list_profiles") return [];
  if (command === "account_keeper_validate_input") {
    return { validCount: 2, maskedAccounts: ["o***r@example.test", "a***n@example.test"] };
  }
  if (command === "account_keeper_validate_template") {
    return {
      valid: true,
      finalLength: 22,
      hasUppercase: true,
      hasLowercase: true,
      hasDigit: true,
      hasSymbol: true,
    };
  }
  if (command === "account_keeper_start_batch") {
    return {
      batch_id: "job-1",
      status: "running",
      updated_at: "2026-07-29T00:00:00Z",
      output_path: "C:\\fixtures\\result.json",
      keep_profile_running: false,
      pause_after_current: false,
      accounts: [],
    };
  }
  return null;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

describe("AccountKeeper", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.open.mockReset();
    mocks.save.mockReset();
    window.history.pushState({}, "", "/");
    delete document.documentElement.dataset.accountKeeperQaConfig;
    delete document.documentElement.dataset.accountKeeperQaStatus;
    mocks.listen.mockResolvedValue(mocks.unlisten);
    mocks.invoke.mockImplementation(defaultInvoke);
  });

  afterEach(cleanup);

  async function prepareInlineBatch() {
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("account_keeper_list_jobs"));
    const accountInput = screen.getByLabelText("Account input");
    fireEvent.change(accountInput, { target: { value: inlineRecord } });
    fireEvent.click(screen.getByRole("button", { name: "Validate Input" }));
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith(
      "account_keeper_validate_input",
      { request: { source: { kind: "inline", text: inlineRecord } } },
    ));

    fireEvent.change(screen.getByLabelText("Template"), {
      target: { value: "Local-{random:16}" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Validate Template" }));
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith(
      "account_keeper_validate_template",
      { request: { template: "Local-{random:16}" } },
    ));

    fireEvent.click(screen.getByRole("button", { name: "Choose output file" }));
    await waitFor(() => expect(mocks.save).toHaveBeenCalled());
    fireEvent.click(screen.getByLabelText(
      "I understand pasted input and the output file contain plaintext secrets",
    ));
    const start = screen.getByRole("button", { name: "Start Batch" });
    await waitFor(() => expect(start).toBeEnabled());
    return { accountInput, start };
  }

  it("subscribes before loading and cleans up under Strict Mode", async () => {
    const view = render(
      <StrictMode>
        <AccountKeeper confirm={vi.fn().mockResolvedValue(true)} />
      </StrictMode>,
    );

    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("account_keeper_list_jobs"));
    expect(mocks.listen).toHaveBeenCalledWith("account-keeper:progress", expect.any(Function));
    expect(mocks.listen.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.invoke.mock.invocationCallOrder.find(
        (_, index) => mocks.invoke.mock.calls[index][0] === "account_keeper_list_jobs",
      ) ?? Number.MAX_SAFE_INTEGER,
    );
    expect(screen.getByRole("button", { name: "Paste text" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByLabelText("Account input")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Validate Input" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Choose output file" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start Batch" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Pause After Current" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel Batch" })).toBeInTheDocument();

    view.unmount();
    await waitFor(() => expect(mocks.unlisten).toHaveBeenCalled());
  });

  it("does not validate defaults after unmount while loading", async () => {
    const defaultsRequest = deferred<unknown>();
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "account_keeper_defaults") return defaultsRequest.promise;
      if (command === "account_keeper_list_jobs") return [];
      return null;
    });
    const view = render(<AccountKeeper confirm={vi.fn().mockResolvedValue(true)} />);

    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("account_keeper_defaults"));
    view.unmount();
    await act(async () => {
      defaultsRequest.resolve({ template: defaultTemplate, outputPath: defaultOutputPath });
      await defaultsRequest.promise;
    });

    expect(mocks.invoke.mock.calls.some(([command]) => command === "account_keeper_validate_template"))
      .toBe(false);
  });

  it("loads and validates editable defaults on mount", async () => {
    mocks.save.mockResolvedValue("C:\\fixtures\\browsed-result.json");
    render(<AccountKeeper confirm={vi.fn().mockResolvedValue(true)} />);

    await waitFor(() => expect(screen.getByLabelText("Template"))
      .toHaveValue(defaultTemplate));
    const output = screen.getByLabelText("Output file");
    expect(output).toHaveValue(defaultOutputPath);
    expect(mocks.invoke).toHaveBeenCalledWith("account_keeper_defaults");
    expect(mocks.invoke).toHaveBeenCalledWith(
      "account_keeper_validate_template",
      { request: { template: defaultTemplate } },
    );
    expect(await screen.findByText("Template valid")).toBeInTheDocument();
    expect(screen.getByLabelText("Account input")).toHaveValue("");
    expect(screen.getByLabelText(
      "I understand pasted input and the output file contain plaintext secrets",
    )).not.toBeChecked();

    fireEvent.change(screen.getByLabelText("Template"), {
      target: { value: "Local-{random:16}" },
    });
    expect(screen.queryByText("Template valid")).not.toBeInTheDocument();

    fireEvent.change(output, { target: { value: "C:\\fixtures\\typed-result.json" } });
    expect(output).toHaveValue("C:\\fixtures\\typed-result.json");
    fireEvent.click(screen.getByRole("button", { name: "Choose output file" }));
    await waitFor(() => expect(output).toHaveValue("C:\\fixtures\\browsed-result.json"));
  });

  it.each([
    ["missing template", { outputPath: defaultOutputPath }],
    ["blank template", { template: "   ", outputPath: defaultOutputPath }],
    ["missing output path", { template: defaultTemplate }],
    ["blank output path", { template: defaultTemplate, outputPath: "   " }],
  ])("rejects %s in Account Keeper defaults", async (_case, defaults) => {
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "account_keeper_defaults") return defaults;
      if (command === "account_keeper_list_jobs") return [];
      return null;
    });
    render(<AccountKeeper confirm={vi.fn().mockResolvedValue(true)} />);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Account Keeper defaults could not load: Invalid Account Keeper defaults",
    );
    expect(screen.getByLabelText("Template")).toHaveValue("");
    expect(screen.getByLabelText("Output file")).toHaveValue("");
    expect(mocks.invoke.mock.calls.some(([command]) => command === "account_keeper_validate_template"))
      .toBe(false);
  });

  it("shows a readable prefixed error when defaults loading rejects with an object", async () => {
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "account_keeper_defaults") {
        throw { message: "defaults unavailable", code: "defaults_offline" };
      }
      if (command === "account_keeper_list_jobs") return [];
      return null;
    });
    render(<AccountKeeper confirm={vi.fn().mockResolvedValue(true)} />);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(
      "Account Keeper defaults could not load: defaults unavailable",
    );
    expect(alert).not.toHaveTextContent("[object Object]");
  });

  it("applies only blank fields when defaults resolve after operator edits", async () => {
    const defaultsRequest = deferred<unknown>();
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "account_keeper_defaults") return defaultsRequest.promise;
      if (command === "account_keeper_list_jobs") return [];
      if (command === "account_keeper_validate_template") {
        return {
          valid: true,
          finalLength: 22,
          hasUppercase: true,
          hasLowercase: true,
          hasDigit: true,
          hasSymbol: true,
        };
      }
      return null;
    });
    render(<AccountKeeper confirm={vi.fn().mockResolvedValue(true)} />);

    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("account_keeper_defaults"));
    fireEvent.change(screen.getByLabelText("Template"), {
      target: { value: "Operator-{random:16}" },
    });
    fireEvent.change(screen.getByLabelText("Account input"), { target: { value: inlineRecord } });
    fireEvent.click(screen.getByLabelText(
      "I understand pasted input and the output file contain plaintext secrets",
    ));
    defaultsRequest.resolve({ template: defaultTemplate, outputPath: defaultOutputPath });

    await waitFor(() => expect(screen.getByLabelText("Output file")).toHaveValue(defaultOutputPath));
    expect(screen.getByLabelText("Template")).toHaveValue("Operator-{random:16}");
    expect(screen.queryByText("Template valid")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Account input")).toHaveValue(inlineRecord);
    expect(screen.getByLabelText(
      "I understand pasted input and the output file contain plaintext secrets",
    )).toBeChecked();
  });

  it("preserves an output edit while default template validation is pending", async () => {
    const validationRequest = deferred<unknown>();
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "account_keeper_defaults") {
        return { template: defaultTemplate, outputPath: defaultOutputPath };
      }
      if (command === "account_keeper_list_jobs") return [];
      if (command === "account_keeper_validate_template") return validationRequest.promise;
      return null;
    });
    render(<AccountKeeper confirm={vi.fn().mockResolvedValue(true)} />);

    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith(
      "account_keeper_validate_template",
      { request: { template: defaultTemplate } },
    ));
    fireEvent.change(screen.getByLabelText("Output file"), {
      target: { value: "C:\\fixtures\\operator-result.json" },
    });
    validationRequest.resolve({
      valid: true,
      finalLength: 22,
      hasUppercase: true,
      hasLowercase: true,
      hasDigit: true,
      hasSymbol: true,
    });

    await waitFor(() => expect(screen.getByLabelText("Template")).toHaveValue(defaultTemplate));
    expect(await screen.findByText("Template valid")).toBeInTheDocument();
    expect(screen.getByLabelText("Output file")).toHaveValue("C:\\fixtures\\operator-result.json");
  });

  it("validates pasted records, starts with inline source, and clears the textarea", async () => {
    mocks.save.mockResolvedValue("C:\\fixtures\\result.json");
    const confirm = vi.fn().mockResolvedValue(true);
    render(<AccountKeeper confirm={confirm} />);

    const { accountInput, start } = await prepareInlineBatch();
    fireEvent.click(start);

    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith(
      "account_keeper_start_batch",
      {
        request: {
          source: { kind: "inline", text: inlineRecord },
          outputPath: "C:\\fixtures\\result.json",
          template: "Local-{random:16}",
          adapterId: "openai-chatgpt-v1",
          operation: "change_password",
          keepProfileRunning: false,
          pauseAfterCurrent: false,
        },
      },
    ));
    await waitFor(() => expect(accountInput).toHaveValue(""));
    expect(confirm).toHaveBeenCalled();
    expect(mocks.invoke).not.toHaveBeenCalledWith("read_text_file", expect.anything());
  });

  it("keeps pasted input when starting fails", async () => {
    mocks.save.mockResolvedValue("C:\\fixtures\\result.json");
    render(<AccountKeeper confirm={vi.fn().mockResolvedValue(true)} />);
    const { accountInput, start } = await prepareInlineBatch();
    mocks.invoke.mockRejectedValueOnce(new Error("start failed"));

    fireEvent.click(start);

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("start failed"));
    expect(accountInput).toHaveValue(inlineRecord);
  });

  it("keeps pasted input when confirmation is cancelled", async () => {
    mocks.save.mockResolvedValue("C:\\fixtures\\result.json");
    const confirm = vi.fn().mockResolvedValue(false);
    render(<AccountKeeper confirm={confirm} />);
    const { accountInput, start } = await prepareInlineBatch();

    fireEvent.click(start);

    await waitFor(() => expect(confirm).toHaveBeenCalled());
    expect(mocks.invoke.mock.calls.some(([command]) => command === "account_keeper_start_batch")).toBe(false);
    expect(accountInput).toHaveValue(inlineRecord);
  });

  it("keeps the template editable and invalidates validation after inline edits", async () => {
    render(<AccountKeeper confirm={vi.fn().mockResolvedValue(true)} />);
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("account_keeper_list_jobs"));
    expect(screen.getByLabelText("Template")).toBeEnabled();

    const accountInput = screen.getByLabelText("Account input");
    fireEvent.change(accountInput, { target: { value: inlineRecord } });
    fireEvent.click(screen.getByRole("button", { name: "Validate Input" }));
    expect(await screen.findByText("Input valid")).toBeInTheDocument();

    fireEvent.change(accountInput, { target: { value: `${inlineRecord}\n` } });
    expect(screen.queryByText("Input valid")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start Batch" })).toBeDisabled();
    expect(screen.getByLabelText("Template")).toBeEnabled();
  });

  it("preserves both drafts, invalidates file changes, and clears pasted text after file start", async () => {
    mocks.open.mockResolvedValue("C:\\fixtures\\batch.txt");
    mocks.save.mockResolvedValue("C:\\fixtures\\result.json");
    render(<AccountKeeper confirm={vi.fn().mockResolvedValue(true)} />);

    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("account_keeper_list_jobs"));
    fireEvent.change(screen.getByLabelText("Account input"), { target: { value: inlineRecord } });
    fireEvent.click(screen.getByRole("button", { name: "Choose file" }));
    fireEvent.click(screen.getByRole("button", { name: "Choose input file" }));
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith(
      "account_keeper_validate_input",
      { request: { source: { kind: "file", path: "C:\\fixtures\\batch.txt" } } },
    ));

    fireEvent.change(screen.getByLabelText("Template"), { target: { value: "Local-{random:16}" } });
    fireEvent.click(screen.getByRole("button", { name: "Validate Template" }));
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith(
      "account_keeper_validate_template",
      { request: { template: "Local-{random:16}" } },
    ));
    fireEvent.click(screen.getByRole("button", { name: "Choose output file" }));
    await waitFor(() => expect(mocks.save).toHaveBeenCalled());
    fireEvent.click(screen.getByLabelText(
      "I understand the selected input and output files contain plaintext secrets",
    ));

    const start = screen.getByRole("button", { name: "Start Batch" });
    await waitFor(() => expect(start).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Paste text" }));
    expect(screen.getByLabelText("Account input")).toHaveValue(inlineRecord);
    expect(screen.getByLabelText(
      "I understand pasted input and the output file contain plaintext secrets",
    )).not.toBeChecked();
    expect(start).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Choose file" }));
    expect(screen.getByLabelText("Input file")).toHaveValue("C:\\fixtures\\batch.txt");
    const fileAcknowledgement = screen.getByLabelText(
      "I understand the selected input and output files contain plaintext secrets",
    );
    expect(fileAcknowledgement).not.toBeChecked();
    fireEvent.click(fileAcknowledgement);
    expect(start).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Choose input file" }));
    await waitFor(() => expect(start).toBeEnabled());

    mocks.open.mockResolvedValueOnce("C:\\fixtures\\batch-2.txt");
    mocks.invoke.mockRejectedValueOnce(new Error("invalid input"));
    fireEvent.click(screen.getByRole("button", { name: "Choose input file" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("invalid input"));
    expect(screen.getByLabelText("Input file")).toHaveValue("C:\\fixtures\\batch-2.txt");
    expect(start).toBeDisabled();

    mocks.open.mockResolvedValueOnce("C:\\fixtures\\batch.txt");
    fireEvent.click(screen.getByRole("button", { name: "Choose input file" }));
    await waitFor(() => expect(start).toBeEnabled());
    fireEvent.click(start);
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith(
      "account_keeper_start_batch",
      expect.objectContaining({
        request: expect.objectContaining({
          source: { kind: "file", path: "C:\\fixtures\\batch.txt" },
        }),
      }),
    ));
    await screen.findByText("Batch started.");

    fireEvent.click(screen.getByRole("button", { name: "Paste text" }));
    expect(screen.getByLabelText("Account input")).toHaveValue("");
  });

  it("toggles redacted logs and cleans selected terminal progress", async () => {
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "account_keeper_list_jobs") return [failedJob];
      if (command === "account_keeper_get_job") return failedJob;
      if (command === "account_keeper_clean_progress") {
        return { batchId: failedJob.batch_id, cleaned: true, forgottenRecoveryAccounts: 1 };
      }
      return defaultInvoke(command);
    });
    render(<AccountKeeper confirm={vi.fn().mockResolvedValue(true)} />);

    await screen.findByText("o***r@example.test");
    fireEvent.click(screen.getByRole("button", { name: "Logs" }));
    const logs = await screen.findByRole("region", { name: "Progress logs" });
    expect(logs).toHaveTextContent("flow_changed");
    expect(logs).not.toHaveTextContent("current-password");

    fireEvent.click(screen.getByRole("button", { name: "Clean" }));
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith(
      "account_keeper_clean_progress",
      { request: { batchId: failedJob.batch_id } },
    ));
    await screen.findByText("No progress to display.");
    expect(screen.getByText("Progress cleaned. Unknown recovery state forgotten; browser profile was preserved.")).toBeInTheDocument();
  });

  it("lists successful profiles with run, delete, and import actions", async () => {
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "account_keeper_list_profiles") return [managedProfile];
      if (command === "account_keeper_open_profile") return { launched: true, already_running: false };
      if (command === "account_keeper_delete_profile") return { profile_id: "profile-1", deleted: true };
      return defaultInvoke(command);
    });
    render(<AccountKeeper confirm={vi.fn().mockResolvedValue(true)} />);

    expect(await screen.findByRole("heading", { name: "Profiles" })).toBeInTheDocument();
    expect(screen.getByText("o***r@example.test")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Run profile o***r@example.test" }));
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith(
      "account_keeper_open_profile",
      { request: { profileId: "profile-1" } },
    ));

    fireEvent.click(screen.getByRole("button", { name: "Import info o***r@example.test" }));
    const importInfo = await screen.findByRole("region", { name: "9Router/Cockpit import info" });
    const importPayload = importInfo.querySelector("pre")?.textContent ?? "";
    expect(importPayload).toContain("brproxies-account-keeper-profile");
    expect(importPayload).not.toContain("password");
    expect(importPayload).not.toContain("totp");

    fireEvent.click(screen.getByRole("button", { name: "Delete profile o***r@example.test" }));
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith(
      "account_keeper_delete_profile",
      { request: { profileId: "profile-1" } },
    ));
  });

  it("accepts synthetic QA configuration only through the dev bridge", async () => {
    window.history.pushState({}, "", "/?account-keeper-qa=1");
    render(<AccountKeeper confirm={vi.fn().mockResolvedValue(true)} />);

    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("account_keeper_list_jobs"));
    await waitFor(() => expect(document.documentElement.dataset.accountKeeperQaStatus).toBe("idle"));
    document.documentElement.dataset.accountKeeperQaConfig = JSON.stringify({
      source: { kind: "inline", text: inlineRecord },
      outputPath: "C:\\fixtures\\result.json",
      templateText: "Local-{random:16}",
      adapterId: "fixture-v1",
    });
    document.documentElement.dispatchEvent(new Event("account-keeper:qa-configure"));

    await waitFor(() => expect(document.documentElement.dataset.accountKeeperQaConfig).toBeUndefined());
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith(
      "account_keeper_validate_input",
      { request: { source: { kind: "inline", text: inlineRecord } } },
    ));
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith(
      "account_keeper_validate_template",
      { request: { template: "Local-{random:16}" } },
    ));
    await waitFor(() => expect(screen.getByLabelText("Template")).toHaveValue("Local-{random:16}"));
    fireEvent.click(screen.getByLabelText(
      "I understand pasted input and the output file contain plaintext secrets",
    ));
    fireEvent.click(screen.getByRole("button", { name: "Start Batch" }));

    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith(
      "account_keeper_start_batch",
      {
        request: {
          source: { kind: "inline", text: inlineRecord },
          outputPath: "C:\\fixtures\\result.json",
          template: "Local-{random:16}",
          adapterId: "fixture-v1",
          operation: "change_password",
          keepProfileRunning: false,
          pauseAfterCurrent: false,
        },
      },
    ));
  });

  it("accepts a tagged file source through the synthetic QA bridge", async () => {
    window.history.pushState({}, "", "/?account-keeper-qa=1");
    render(<AccountKeeper confirm={vi.fn().mockResolvedValue(true)} />);

    await waitFor(() => expect(document.documentElement.dataset.accountKeeperQaStatus).toBe("idle"));
    document.documentElement.dataset.accountKeeperQaConfig = JSON.stringify({
      source: { kind: "file", path: "C:\\fixtures\\batch.txt" },
      outputPath: "C:\\fixtures\\result.json",
      templateText: "Local-{random:16}",
      adapterId: "fixture-v1",
    });
    document.documentElement.dispatchEvent(new Event("account-keeper:qa-configure"));

    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith(
      "account_keeper_validate_input",
      { request: { source: { kind: "file", path: "C:\\fixtures\\batch.txt" } } },
    ));
    fireEvent.click(screen.getByLabelText(
      "I understand the selected input and output files contain plaintext secrets",
    ));
    fireEvent.click(screen.getByRole("button", { name: "Start Batch" }));

    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith(
      "account_keeper_start_batch",
      {
        request: {
          source: { kind: "file", path: "C:\\fixtures\\batch.txt" },
          outputPath: "C:\\fixtures\\result.json",
          template: "Local-{random:16}",
          adapterId: "fixture-v1",
          operation: "change_password",
          keepProfileRunning: false,
          pauseAfterCurrent: false,
        },
      },
    ));
  });

  it("rejects mixed synthetic QA source shapes with a redacted status", async () => {
    window.history.pushState({}, "", "/?account-keeper-qa=1");
    render(<AccountKeeper confirm={vi.fn().mockResolvedValue(true)} />);

    await waitFor(() => expect(document.documentElement.dataset.accountKeeperQaStatus).toBe("idle"));
    document.documentElement.dataset.accountKeeperQaConfig = JSON.stringify({
      source: { kind: "inline", text: inlineRecord, path: "C:\\fixtures\\batch.txt" },
      outputPath: "C:\\fixtures\\result.json",
      templateText: "Local-{random:16}",
      adapterId: "fixture-v1",
    });
    document.documentElement.dispatchEvent(new Event("account-keeper:qa-configure"));

    await waitFor(() => expect(document.documentElement.dataset.accountKeeperQaStatus)
      .toBe("error:invalid_config"));
    expect(document.documentElement.dataset.accountKeeperQaConfig).toBeUndefined();
    expect(mocks.invoke.mock.calls.some(([command]) => command === "account_keeper_validate_input")).toBe(false);
  });
});
