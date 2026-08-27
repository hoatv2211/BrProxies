import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openPath: vi.fn(), openUrl: vi.fn() }));

describe("ProxiesView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("localStorage", {
      getItem: vi.fn().mockReturnValue(null),
      setItem: vi.fn(),
      removeItem: vi.fn(),
      clear: vi.fn(),
      key: vi.fn().mockReturnValue(null),
      length: 0,
    });
    mocks.listen.mockResolvedValue(vi.fn());
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "runtime_status") {
        return { spec: null, installed: true, fingerprints_installed: true };
      }
      if (command === "proxy_list") {
        return [{
          id: "proxy-1",
          name: "Fast proxy",
          kind: "http",
          host: "1.2.3.4",
          port: 8080,
          username: "",
          password: "",
          country: "US",
          notes: "",
        }];
      }
      if (command === "profile_list") return [];
      if (command === "proxy_last_test") {
        return {
          first_seen: "@1",
          last_seen: "@2",
          ip: "1.2.3.4",
          country_code: "US",
          country: "United States",
          region: "",
          city: "",
          isp: "",
          timezone: "",
          latitude: 0,
          longitude: 0,
          tcp_ms: 87,
          udp_ms: null,
          udp_error: null,
          provider: "unit",
        };
      }
      return null;
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("shows the latest TCP latency in its own column", async () => {
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Proxies" }));

    expect(screen.getByText("Latency")).toBeInTheDocument();
    expect(await screen.findByText("87 ms")).toBeInTheDocument();
  });
});
