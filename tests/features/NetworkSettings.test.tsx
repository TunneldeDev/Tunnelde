import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import i18n from "@/i18n/i18n";
import { NetworkSettingsSection } from "@/features/settings/NetworkSettings";
import { createDefaultSettings } from "@/lib/prefs/defaults";
import { useSettings } from "@/store/settings";
import { usePlugins } from "@/store/plugins";
import type { Settings } from "@/lib/api/types";

const api = vi.hoisted(() => ({ saveProxyPassword: vi.fn(), testProxy: vi.fn() }));
vi.mock("@/lib/api/ipc", () => ({ api, isTauri: () => true }));
const update = vi.fn(async (patch: Partial<Settings>) => {
  useSettings.setState({ settings: { ...useSettings.getState().settings, ...patch } });
  return true;
});
const proxy = {
  id: "office",
  name: "Office",
  protocol: "http" as const,
  host: "127.0.0.1",
  port: 7890,
  username: "",
};

beforeEach(async () => {
  vi.clearAllMocks();
  api.saveProxyPassword.mockResolvedValue(undefined);
  api.testProxy.mockResolvedValue(undefined);
  await i18n.changeLanguage("en-US");
  useSettings.setState({
    settings: {
      ...createDefaultSettings("windows"),
      network: { profiles: [proxy], defaultProxy: "system", features: {} },
    },
    update,
  });
  usePlugins.setState({ items: [] });
});

it("keeps cancelled edits private and writes passwords separately from exported settings", async () => {
  render(<NetworkSettingsSection />);
  fireEvent.click(screen.getByRole("button", { name: "Edit" }));
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: "secret" } });
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(update).not.toHaveBeenCalled();
  expect(api.saveProxyPassword).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Edit" }));
  expect((screen.getByLabelText("Password") as HTMLInputElement).value).toBe("");
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: "secret" } });
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Save" })));
  expect(api.saveProxyPassword).toHaveBeenCalledExactlyOnceWith("office", "secret");
  expect(JSON.stringify(update.mock.calls)).not.toContain("secret");
  expect(screen.queryByLabelText("Password")).toBeNull();
});

it("retains the editor and reports a credential-store failure instead of claiming success", async () => {
  api.saveProxyPassword.mockRejectedValue(new Error("Keychain unavailable"));
  render(<NetworkSettingsSection />);
  fireEvent.click(screen.getByRole("button", { name: "Edit" }));
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: "secret" } });
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Save" })));
  expect(screen.getByRole("alert").textContent).toContain("Keychain unavailable");
  expect(screen.getByLabelText("Password")).toBeTruthy();
});

it("saves an individual feature route and tests the explicitly selected proxy", async () => {
  render(<NetworkSettingsSection />);
  fireEvent.click(screen.getByRole("button", { name: "Application updates" }));
  fireEvent.click(screen.getByRole("option", { name: "Office" }));
  await waitFor(() =>
    expect(useSettings.getState().settings.network.features.updates).toBe("office"),
  );
  fireEvent.click(screen.getByRole("button", { name: "Proxy" }));
  fireEvent.click(screen.getByRole("option", { name: "Office" }));
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Test connection" })));
  expect(api.testProxy).toHaveBeenCalledExactlyOnceWith("office", "github.com", 443);
  expect(screen.getByRole("status").textContent).toContain("Connection established");
});

it("forgets a saved password only after explicit selection and save", async () => {
  render(<NetworkSettingsSection />);
  fireEvent.click(screen.getByRole("button", { name: "Edit" }));
  fireEvent.click(screen.getByRole("switch", { name: "Forget saved proxy password" }));
  expect(api.saveProxyPassword).not.toHaveBeenCalled();
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Save" })));
  expect(api.saveProxyPassword).toHaveBeenCalledExactlyOnceWith("office", null);
});
