import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode, useEffect, useLayoutEffect } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@/lib/api/ipc", () => ({ isTauri: () => true, api: {} }));
import "@/i18n/i18n";
import { ForwardingSection } from "@/features/forwarding/ForwardingSection";
import type { ForwardInfo } from "@/features/forwarding/model/contract";
import { frontendRuntime } from "@/lib/extensions/frontendRuntime";
import type { FrontendForwarding, FrontendViewProps } from "@/lib/extensions/uiSdkContract";
import type { Host, PluginInfo } from "@/lib/api/types";
import { useSettings } from "@/store/settings";
import { usePlugins } from "@/store/plugins";
import { usePluginSecurity } from "@/store/pluginSecurity";
import { useSsh } from "@/store/ssh";
import { useDialogs } from "@/store/dialogs";
import { DEFAULT_SETTINGS } from "@/lib/prefs/defaults";
import { uiProviders } from "@/lib/extensions/providers";

const plugin = {
  id: "forwarding-ui",
  name: "Forwarding UI",
  status: "running",
  fingerprint: "approved",
  runtime: "frontend",
  frontend: { entry: "ui/index.mjs", sdk: "^0.1.0" },
  permissions: ["ui.trusted", "hosts.read", "forwards.read", "forwards.write"],
  views: [{ id: "forwards", title: "Forwarding", kind: "component", provider: "forwarding" }],
} as PluginInfo;
const selected = { forwarding: { pluginId: plugin.id, viewId: "forwards" } };
const host = { id: "host", name: "Host" } as Host;
const rule: ForwardInfo = {
  id: "rule",
  hostId: "host",
  name: "Database",
  mode: "local",
  bindHost: "127.0.0.1",
  bindPort: 15432,
  targetHost: "localhost",
  targetPort: 5432,
  revision: "version",
  active: false,
  sessionId: null,
  runtimeId: null,
};
let retained: FrontendForwarding;
let showEntries = false;
let savedRows: ForwardInfo[] = [];
const unmounted = vi.fn();
function Provider({ forwarding }: FrontendViewProps) {
  useLayoutEffect(() => {
    retained = forwarding!;
  });
  useEffect(
    () => () => {
      unmounted();
    },
    [],
  );
  const Entries = forwarding!.Entries;
  return (
    <section aria-label="custom forwarding">{showEntries ? <Entries /> : "Rows omitted"}</section>
  );
}
beforeEach(() => {
  vi.clearAllMocks();
  savedRows = [rule];
  showEntries = false;
  invoke.mockReset().mockImplementation(async (name, args) => {
    if (name === "forwarding_list") return savedRows;
    if (name === "forwarding_provider_open") return "scope";
    if (name === "forwarding_save") return { ...args.rule, id: "rule", revision: "new-version" };
  });
  useSsh.setState({ sessions: [] });
  useDialogs.setState({ confirm: vi.fn() });
  useSettings.setState({ settings: { ...DEFAULT_SETTINGS, uiProviders: selected } });
  usePlugins.setState({ items: [plugin] });
  usePluginSecurity.setState((state) => ({
    state: { ...state.state, restricted: false, grants: { [plugin.id]: plugin.permissions } },
  }));
  vi.spyOn(frontendRuntime, "view").mockReturnValue(Provider);
  vi.spyOn(frontendRuntime, "token").mockReturnValue("token");
  vi.spyOn(frontendRuntime, "ensure").mockResolvedValue();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
async function fixture() {
  const view = render(<ForwardingSection host={host} />);
  await waitFor(() => expect(retained.snapshot.total).toBe(1));
  return view;
}

it("allows omitted native rows while preserving the provider and host editor through save", async () => {
  await fixture();
  expect(screen.queryByText("Database")).toBeNull();
  const original = retained;
  act(() => retained.requestEdit("rule"));
  expect(screen.getByLabelText("Name")).toHaveProperty("value", "Database");
  expect(unmounted).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Renamed" } });
  fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith(
      "forwarding_save",
      expect.objectContaining({
        origin: { token: "token", scope: "scope" },
        expectedRevision: "version",
        rule: expect.objectContaining({ name: "Renamed" }),
      }),
    ),
  );
  await waitFor(() => expect(screen.queryByLabelText("Name")).toBeNull());
  expect(unmounted).not.toHaveBeenCalled();
  expect(() => original.refresh()).toThrow("changed");
});

it("retains native rows on restore and revokes delayed deletion before React commits", async () => {
  showEntries = true;
  await fixture();
  const row = screen.getByText("Database");
  expect(screen.getByRole("region", { name: "custom forwarding" }).contains(row)).toBe(true);
  act(() => retained.requestRemove("rule"));
  const confirmation = vi.mocked(useDialogs.getState().confirm).mock.calls.at(-1)![0];
  const old = retained;
  act(() => {
    useSettings.setState((state) => ({ settings: { ...state.settings, uiProviders: {} } }));
    expect(() => old.requestAdd()).toThrow("viewUnavailable");
  });
  expect(screen.getByText("Database")).toBe(row);
  await act(async () => {
    await confirmation.onConfirm();
  });
  expect(invoke).not.toHaveBeenCalledWith("forwarding_remove", expect.anything());
});

it("enforces read/write grants, token replacement and StrictMode without registering unused scopes", async () => {
  usePlugins.setState({
    items: [{ ...plugin, permissions: plugin.permissions.filter((p) => p !== "forwards.write") }],
  });
  const view = render(
    <StrictMode>
      <ForwardingSection host={host} />
    </StrictMode>,
  );
  await waitFor(() => expect(retained.snapshot.busy).toBe(false));
  await waitFor(() => expect(retained.snapshot.total).toBe(1));
  expect(retained.capabilities.write).toBe(false);
  expect(retained.read({ revision: retained.snapshot.revision }).items[0]!.id).toBe("rule");
  expect(() => retained.requestAdd()).toThrow("permissionDenied");
  expect(invoke).not.toHaveBeenCalledWith("forwarding_provider_open", expect.anything());
  act(() => usePlugins.setState({ items: [plugin] }));
  const before = retained;
  vi.mocked(frontendRuntime.token).mockReturnValue("replacement");
  expect(() => before.requestAdd()).toThrow("viewUnavailable");
  view.unmount();
  expect(() => before.refresh()).toThrow("viewUnavailable");
  for (const permission of ["ui.trusted", "hosts.read", "forwards.read"])
    expect(
      uiProviders(
        [{ ...plugin, permissions: plugin.permissions.filter((p) => p !== permission) }],
        "forwarding",
      ),
    ).toEqual([]);
});

it("retires a provider across a batched selection round trip", async () => {
  await fixture();
  const old = retained;
  act(() => {
    useSettings.setState((state) => ({ settings: { ...state.settings, uiProviders: {} } }));
    useSettings.setState((state) => ({ settings: { ...state.settings, uiProviders: selected } }));
    expect(() => old.requestAdd()).toThrow("viewUnavailable");
  });
  expect(() => old.requestAdd()).toThrow("viewUnavailable");
  act(() => retained.requestEdit("rule"));
  expect(screen.getByLabelText("Name")).toHaveProperty("value", "Database");
});

it("recovers the original native rows after duplicate provider mounts", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.mocked(frontendRuntime.view).mockReturnValue(({ forwarding }) => {
    const Entries = forwarding!.Entries;
    return (
      <>
        <Entries />
        <Entries />
      </>
    );
  });
  render(<ForwardingSection host={host} />);
  await screen.findByText("Database");
  expect(screen.getByRole("alert").textContent).toContain("more than once");
  expect(screen.getAllByText("Database")).toHaveLength(1);
});
