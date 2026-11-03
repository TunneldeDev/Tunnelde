import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import i18n from "@/i18n/i18n";
import { NetworkSettingsSection } from "@/features/settings/NetworkSettings";
import { createDefaultSettings } from "@/lib/prefs/defaults";
import { useSettings } from "@/store/settings";
import { usePlugins } from "@/store/plugins";
import type { PluginInfo, Settings } from "@/lib/api/types";

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

it("keeps the proxy editor in its section and protects the current draft while saving", async () => {
  let finish!: () => void;
  api.saveProxyPassword.mockReturnValueOnce(
    new Promise<void>((resolve) => {
      finish = resolve;
    }),
  );
  render(<NetworkSettingsSection />);
  const profiles = within(screen.getByRole("region", { name: "Proxy profiles" }));
  fireEvent.click(profiles.getByRole("button", { name: "Edit" }));
  const editor = profiles.getByRole("form", { name: "Edit proxy" });
  expect(within(editor).getByRole("group", { name: "Connection" })).toBeTruthy();
  expect(within(editor).getByRole("group", { name: "Authentication (optional)" })).toBeTruthy();
  // Clicking the visible label operates the switch, rather than just its small thumb.
  fireEvent.click(within(editor).getByText("Forget saved proxy password"));
  expect(within(editor).getByRole("switch").getAttribute("aria-checked")).toBe("true");
  fireEvent.click(profiles.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(api.saveProxyPassword).toHaveBeenCalled());
  for (const name of ["Edit", "Delete", "Add proxy", "Cancel"]) {
    expect(profiles.getByRole("button", { name }).matches(":disabled")).toBe(true);
  }
  expect(within(editor).getByLabelText("Name").matches(":disabled")).toBe(true);
  await act(async () => finish());
  expect(profiles.queryByRole("form")).toBeNull();
  expect(profiles.getByRole("button", { name: "Edit" }).matches(":disabled")).toBe(false);
});

it("validates the destination, locks the running test and clears stale results on edits", async () => {
  let finish!: () => void;
  api.testProxy.mockReturnValueOnce(
    new Promise<void>((resolve) => {
      finish = resolve;
    }),
  );
  render(<NetworkSettingsSection />);
  const form = screen.getByRole("form", { name: "Test connection" });
  const test = within(form);
  const address = test.getByLabelText("Destination address");
  const port = test.getByLabelText("Port");
  fireEvent.change(port, { target: { value: "65536" } });
  expect(test.getByRole("button", { name: "Test connection" }).matches(":disabled")).toBe(true);
  fireEvent.submit(form);
  expect(api.testProxy).not.toHaveBeenCalled();
  fireEvent.change(port, { target: { value: "443" } });
  fireEvent.change(address, { target: { value: "   " } });
  fireEvent.submit(form);
  expect(api.testProxy).not.toHaveBeenCalled();
  fireEvent.change(address, { target: { value: " example.com " } });
  fireEvent.submit(form);
  await waitFor(() => expect(api.testProxy).toHaveBeenCalledWith("system", "example.com", 443));
  expect(address.matches(":disabled")).toBe(true);
  expect(test.getByRole("button", { name: "Proxy" }).matches(":disabled")).toBe(true);
  fireEvent.submit(form);
  expect(api.testProxy).toHaveBeenCalledOnce();
  await act(async () => finish());
  expect(test.getByRole("status").textContent).toContain("Connection established");
  fireEvent.change(address, { target: { value: "different.example.com" } });
  expect(test.getByRole("status").textContent).toBe("");
});

it("saves plugin routing independently and retains choices across collapse", async () => {
  usePlugins.setState({ items: [{ id: "assistant", name: "Team assistant" } as PluginInfo] });
  render(<NetworkSettingsSection />);
  const summary = screen.getByText("Individual plugin overrides");
  const details = summary.closest("details")!;
  expect(details.open).toBe(false);
  fireEvent.click(summary);
  expect(details.open).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Team assistant" }));
  fireEvent.click(screen.getByRole("option", { name: "Office" }));
  await waitFor(() =>
    expect(useSettings.getState().settings.network.features["plugin:assistant"]).toBe("office"),
  );
  fireEvent.click(summary);
  expect(details.open).toBe(false);
  fireEvent.click(summary);
  expect(screen.getByRole("button", { name: "Team assistant" }).textContent).toContain("Office");
});
