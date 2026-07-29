import { StrictMode } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

describe("AccountKeeper", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listen.mockResolvedValue(mocks.unlisten);
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "account_keeper_list_jobs") return [];
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
    });
  });

  afterEach(cleanup);

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
    expect(screen.getByRole("button", { name: "Choose input file" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Choose output file" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start Batch" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Pause After Current" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel Batch" })).toBeInTheDocument();

    view.unmount();
    await waitFor(() => expect(mocks.unlisten).toHaveBeenCalled());
  });

  it("selects paths through dialogs and starts with validated redacted state", async () => {
    mocks.open.mockResolvedValue("C:\\fixtures\\batch.txt");
    mocks.save.mockResolvedValue("C:\\fixtures\\result.json");
    const confirm = vi.fn().mockResolvedValue(true);
    render(<AccountKeeper confirm={confirm} />);

    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("account_keeper_list_jobs"));
    fireEvent.click(screen.getByRole("button", { name: "Choose input file" }));
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith(
      "account_keeper_validate_input",
      { request: { inputPath: "C:\\fixtures\\batch.txt" } },
    ));

    fireEvent.change(screen.getByLabelText("Template"), {
      target: { value: "Local-{random:16}" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Validate Template" }));
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith(
      "account_keeper_validate_template",
      { request: { template: "Local-{random:16}" } },
    ));
    expect(await screen.findByText("Uppercase · Lowercase · Digit · Symbol")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Choose output file" }));
    await waitFor(() => expect(mocks.save).toHaveBeenCalled());
    fireEvent.click(screen.getByLabelText("I understand the selected input and output files contain plaintext secrets"));

    const start = screen.getByRole("button", { name: "Start Batch" });
    await waitFor(() => expect(start).toBeEnabled());
    fireEvent.click(start);

    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith(
      "account_keeper_start_batch",
      {
        request: {
          inputPath: "C:\\fixtures\\batch.txt",
          outputPath: "C:\\fixtures\\result.json",
          template: "Local-{random:16}",
          adapterId: "openai-chatgpt-v1",
          keepProfileRunning: false,
          pauseAfterCurrent: false,
        },
      },
    ));
    expect(confirm).toHaveBeenCalled();
    expect(mocks.invoke).not.toHaveBeenCalledWith("read_text_file", expect.anything());
  });

  it("accepts synthetic QA configuration only through the dev bridge", async () => {
    window.history.pushState({}, "", "/?account-keeper-qa=1");
    const confirm = vi.fn().mockResolvedValue(true);
    render(<AccountKeeper confirm={confirm} />);

    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("account_keeper_list_jobs"));
    await waitFor(() => expect(document.documentElement.dataset.accountKeeperQaStatus).toBe("idle"));
    document.documentElement.dataset.accountKeeperQaConfig = JSON.stringify({
      inputPath: "C:\\fixtures\\batch.txt",
      outputPath: "C:\\fixtures\\result.json",
      templateText: "Local-{random:16}",
      adapterId: "fixture-v1",
    });
    document.documentElement.dispatchEvent(new Event("account-keeper:qa-configure"));

    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith(
      "account_keeper_validate_input",
      { request: { inputPath: "C:\\fixtures\\batch.txt" } },
    ));
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith(
      "account_keeper_validate_template",
      { request: { template: "Local-{random:16}" } },
    ));
    await waitFor(() => expect(screen.getByLabelText("Template")).toHaveValue("Local-{random:16}"));
    fireEvent.click(screen.getByLabelText("I understand the selected input and output files contain plaintext secrets"));
    fireEvent.click(screen.getByRole("button", { name: "Start Batch" }));

    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith(
      "account_keeper_start_batch",
      {
        request: {
          inputPath: "C:\\fixtures\\batch.txt",
          outputPath: "C:\\fixtures\\result.json",
          template: "Local-{random:16}",
          adapterId: "fixture-v1",
          keepProfileRunning: false,
          pauseAfterCurrent: false,
        },
      },
    ));
  });
});
