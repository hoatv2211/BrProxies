import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TotpAuthenticator } from "./TotpAuthenticator";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const syntheticSecret = "JBSWY3DPEHPK3PXP";
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(59_000);
  invoke.mockReset();
  invoke.mockResolvedValue({ code: "123456", expiresAt: 60 });
});
afterEach(() => { cleanup(); vi.useRealTimers(); });
async function generate() {
  fireEvent.change(screen.getByLabelText("2FA secret"), { target: { value: syntheticSecret } });
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Get code" })); });
}

it("hides the secret and copies only the current code", async () => {
  render(<TotpAuthenticator />);
  expect(screen.getByLabelText("2FA secret")).toHaveAttribute("type", "password");
  await generate();
  expect(screen.getByText("123456")).toBeInTheDocument();
  expect(screen.getByText("Expires in 1s")).toBeInTheDocument();
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Copy code" })); });
  expect(invoke).toHaveBeenCalledWith("clipboard_write", { text: "123456" });
  expect(screen.getByRole("status")).toHaveTextContent("Code copied.");
  fireEvent.click(screen.getByRole("button", { name: "Show secret" }));
  expect(screen.getByLabelText("2FA secret")).toHaveAttribute("type", "text");
  fireEvent.click(screen.getByRole("button", { name: "Clear" }));
  expect(screen.getByLabelText("2FA secret")).toHaveValue("");
  expect(screen.queryByText("123456")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Copy code" })).toBeDisabled();
});

it("refreshes at expiry and stops on edit", async () => {
  render(<TotpAuthenticator />);
  await generate();
  invoke.mockResolvedValue({ code: "654321", expiresAt: 90 });
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  expect(screen.getByText("654321")).toBeInTheDocument();
  expect(screen.getByText("Expires in 30s")).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("2FA secret"), { target: { value: "changed" } });
  expect(screen.queryByText("654321")).not.toBeInTheDocument();
  invoke.mockClear();
  await act(async () => { await vi.advanceTimersByTimeAsync(31_000); });
  expect(invoke).not.toHaveBeenCalled();
});

it("ignores a late response after Clear", async () => {
  let resolve!: (value: unknown) => void;
  invoke.mockImplementation(() => new Promise((done) => { resolve = done; }));
  render(<TotpAuthenticator />);
  await generate();
  fireEvent.click(screen.getByRole("button", { name: "Clear" }));
  await act(async () => { resolve({ code: "123456", expiresAt: 60 }); });
  expect(screen.queryByText("123456")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Copy code" })).toBeDisabled();
});

it("redacts backend errors and disables expired codes during refresh", async () => {
  render(<TotpAuthenticator />);
  await generate();
  invoke.mockRejectedValue(new Error(syntheticSecret));
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  expect(screen.queryByText("123456")).not.toBeInTheDocument();
  expect(screen.getByRole("alert")).not.toHaveTextContent(syntheticSecret);
  expect(screen.getByRole("button", { name: "Copy code" })).toBeDisabled();
});

it("disables Copy while refreshing and cleans up its timer on unmount", async () => {
  const view = render(<TotpAuthenticator />);
  await generate();
  let resolve!: (value: unknown) => void;
  invoke.mockImplementation(() => new Promise((done) => { resolve = done; }));
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  expect(screen.queryByText("123456")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Copy code" })).toBeDisabled();
  view.unmount();
  await act(async () => { resolve({ code: "654321", expiresAt: 90 }); });
  invoke.mockClear();
  await act(async () => { await vi.advanceTimersByTimeAsync(31_000); });
  expect(invoke).not.toHaveBeenCalled();
});

it("reports clipboard failure without exposing the backend error", async () => {
  render(<TotpAuthenticator />);
  await generate();
  invoke.mockRejectedValue(new Error(syntheticSecret));
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Copy code" })); });
  expect(screen.getByRole("alert")).toHaveTextContent("Could not copy the code.");
  expect(screen.getByRole("alert")).not.toHaveTextContent(syntheticSecret);
  expect(screen.getByText("123456")).toBeInTheDocument();
});

it("retries a code that expires while its IPC response is in flight", async () => {
  let resolve!: (value: unknown) => void;
  invoke.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
  render(<TotpAuthenticator />);
  await generate();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000);
    resolve({ code: "123456", expiresAt: 60 });
  });
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  invoke.mockResolvedValue({ code: "654321", expiresAt: 90 });
  await act(async () => { await vi.advanceTimersByTimeAsync(250); });
  expect(screen.getByText("654321")).toBeInTheDocument();
});
