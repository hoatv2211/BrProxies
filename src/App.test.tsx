import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
  saveDialog: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: mocks.saveDialog }));
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

describe("BrowsersView Codex profile menu", () => {
  const profile = {
    id: "profile-1",
    name: "owner@example.test",
    notes: "",
    proxy_id: null,
    last_launched_at: null,
    created_at: null,
    pinned: false,
    folder: "Account Keeper",
    total_runtime_ms: 0,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(Element.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });
    vi.stubGlobal("localStorage", {
      getItem: vi.fn().mockReturnValue(null),
      setItem: vi.fn(),
      removeItem: vi.fn(),
      clear: vi.fn(),
      key: vi.fn().mockReturnValue(null),
      length: 0,
    });
    mocks.listen.mockResolvedValue(vi.fn());
    mocks.saveDialog.mockResolvedValue("C:\\temp\\owner-9router-codex.json");
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("connects Codex from a verified Account Keeper profile", async () => {
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "runtime_status") return { spec: null, installed: true, fingerprints_installed: true };
      if (command === "profile_list") return [profile];
      if (command === "proxy_list" || command === "fingerprint_list" || command === "process_list" || command === "actions_list") return [];
      if (command === "account_keeper_list_profiles") return [{
        profile_id: profile.id,
        masked_account: "o***@example.test",
        status: "success",
        last_verified_at: "2026-09-12T00:00:00Z",
        running: false,
        rotated: false,
        codex_auth: { status: "missing", expires_at: null, has_account_id: false },
      }];
      if (command === "account_keeper_connect_codex") return {
        status: "ready",
        expires_at: "2026-09-13T00:00:00Z",
        has_account_id: true,
      };
      return null;
    });

    render(<App />);
    const profileName = await screen.findByText(profile.name);
    fireEvent.contextMenu(profileName.closest(".row-wrap") as HTMLElement);
    fireEvent.click(await screen.findByRole("button", { name: "Connect Codex" }));

    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("account_keeper_connect_codex", {
      request: { profileId: profile.id },
    }));
  });

  it("exports ready Codex credentials in the selected import format", async () => {
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "runtime_status") return { spec: null, installed: true, fingerprints_installed: true };
      if (command === "profile_list") return [profile];
      if (command === "proxy_list" || command === "fingerprint_list" || command === "process_list" || command === "actions_list") return [];
      if (command === "account_keeper_list_profiles") return [{
        profile_id: profile.id,
        masked_account: "o***@example.test",
        status: "success",
        last_verified_at: "2026-09-12T00:00:00Z",
        running: false,
        rotated: false,
        codex_auth: { status: "ready", expires_at: "2026-09-13T00:00:00Z", has_account_id: true },
      }];
      if (command === "account_keeper_save_codex_export") return { exportedCount: 1 };
      return null;
    });

    render(<App />);
    const profileName = await screen.findByText(profile.name);
    fireEvent.contextMenu(profileName.closest(".row-wrap") as HTMLElement);

    expect(await screen.findByRole("button", { name: "Reconnect Codex" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Export JSON for 9Router/Cockpit..." }));
    fireEvent.click(await screen.findByRole("button", { name: "9Router JSON" }));

    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("account_keeper_save_codex_export", {
      request: {
        profileIds: [profile.id],
        format: "nine_router",
        outputPath: "C:\\temp\\owner-9router-codex.json",
      },
    }));
  });

  it("persists the per-profile BrProxies Bridge selection", async () => {
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "runtime_status") return { spec: null, installed: true, fingerprints_installed: true };
      if (command === "profile_list") return [profile];
      if (command === "proxy_list" || command === "fingerprint_list" || command === "process_list" || command === "actions_list") return [];
      if (command === "profile_get") return {
        _meta: { id: profile.id, proxy_id: null, bridge_enabled: false },
        name: profile.name,
        notes: "",
        navigator: {},
      };
      if (command === "profile_save") return profile;
      return null;
    });

    render(<App />);
    const profileName = await screen.findByText(profile.name);
    fireEvent.click(profileName.closest(".cell-name") as HTMLElement);
    expect(await screen.findByText("Browser extensions")).toBeInTheDocument();
    fireEvent.click((await screen.findByText("Not included")).closest("button") as HTMLElement);
    fireEvent.click(await screen.findByRole("option", { name: "Include and auto-load" }));
    fireEvent.click(screen.getByRole("button", { name: /Save changes/ }));

    await waitFor(() => {
      const saveCall = mocks.invoke.mock.calls.find(([command]) => command === "profile_save");
      expect(saveCall?.[1]?.payload?._meta?.bridge_enabled).toBe(true);
    });
  });

  it("adds BrProxies Bridge from the profile context menu", async () => {
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "runtime_status") return { spec: null, installed: true, fingerprints_installed: true };
      if (command === "profile_list") return [profile];
      if (command === "proxy_list" || command === "fingerprint_list" || command === "process_list" || command === "actions_list") return [];
      if (command === "account_keeper_list_profiles") return [];
      if (command === "profile_get") return {
        _meta: { id: profile.id, proxy_id: null, bridge_enabled: false },
        name: profile.name,
        notes: "",
        navigator: {},
      };
      if (command === "profile_save") return profile;
      return null;
    });

    render(<App />);
    const profileName = await screen.findByText(profile.name);
    fireEvent.contextMenu(profileName.closest(".row-wrap") as HTMLElement);
    fireEvent.click(await screen.findByRole("button", { name: "Add BrProxies Bridge" }));

    await waitFor(() => {
      const saveCall = mocks.invoke.mock.calls.find(([command]) => command === "profile_save");
      expect(saveCall?.[1]?.payload?._meta?.bridge_enabled).toBe(true);
    });
  });
});
