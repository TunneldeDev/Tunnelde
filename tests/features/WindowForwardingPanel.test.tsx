import "@/i18n/i18n";
import { useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { WindowForwardingPanel } from "@/features/forwarding/components/WindowForwardingPanel";
import {
  createPanelViewState,
  PanelViewStateScope,
  type PanelViewCapsule,
} from "@/lib/panels/viewState";
import type { WindowViewRecord } from "@/lib/panels/windowViews";
import type { PanelWindowClient } from "@/lib/panels/windowClient";
import { createNativePluginViewClient } from "@/lib/panels/windowPluginClient";
import { usePanelWindows } from "@/store/panelWindows";
import type { FrontendViewProps } from "@/lib/extensions/uiSdkContract";
import type { FrontendForwarding } from "@/lib/extensions/contracts/forwarding/provider";
import type { ForwardingReadData } from "@/features/forwarding/data/readModel";
const mock = vi.hoisted(() => ({
  entries: new Map<string, WindowViewRecord>(),
  views: null as { client: PanelWindowClient } | null,
  denied: vi.fn(() => {
    throw new Error("main document access forbidden");
  }),
}));
vi.mock("@/lib/panels/windowViews", () => ({
  useWindowViews: { getState: () => ({ entries: mock.entries }) },
  windowViews: () => mock.views,
}));
vi.mock("@/components/layout/WorkbenchPanel", () => ({
  PanelHeader: () => <header>Forwarding</header>,
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: mock.denied,
  convertFileSrc: (token: string) => `https://native/${token}`,
}));
vi.mock("@/store/hosts", () => ({
  useHosts: Object.assign(() => mock.denied(), { getState: mock.denied, subscribe: mock.denied }),
}));
vi.mock("@/store/ssh", () => ({
  useSsh: Object.assign(() => mock.denied(), { getState: mock.denied, subscribe: mock.denied }),
}));
vi.mock("@/store/navigation", () => ({
  useNavigation: Object.assign(() => mock.denied(), {
    getState: mock.denied,
    subscribe: mock.denied,
  }),
}));
vi.mock("@/store/dialogs", () => ({
  useDialogs: Object.assign(() => mock.denied(), { getState: mock.denied, subscribe: mock.denied }),
}));
const original = usePanelWindows.getState();
const disposals: (() => void)[] = [];
afterEach(() => {
  cleanup();
  for (const dispose of disposals.splice(0)) dispose();
  usePanelWindows.setState(original, true);
  mock.views = null;
  mock.entries.clear();
  expect(mock.denied).not.toHaveBeenCalled();
  vi.clearAllMocks();
});
function fixture(staged = true, capsule?: PanelViewCapsule) {
  const controller = createPanelViewState(capsule);
  const lease = { panelId: "forwarding", windowId: "satellite", generation: 7 };
  let record: WindowViewRecord = {
    key: "offer",
    panelId: "forwarding",
    controller,
    staged,
    ...(!staged ? { lease } : {}),
  };
  const data: ForwardingReadData = {
    hosts: [
      {
        id: "host",
        name: "Server",
        host: "example",
        port: 22,
        username: "qa",
        authMethod: "password",
      },
    ],
    hostsLoading: false,
    sessions: [],
    rules: { entries: [], busy: false, error: null },
    groups: { entries: [], busy: false, error: null },
  };
  const descriptor = {
    selectionRevision: 4,
    capabilities: { write: true },
    view: {
      pluginId: "selected",
      runtimeId: "runtime",
      generation: 3,
      viewId: "forwards",
      entry: "index.mjs",
      sdkVersion: "0.1.0",
      title: "Provider",
      allowFloating: true,
    },
  };
  let forwarding!: FrontendForwarding;
  const activate = vi.fn();
  const disposeInstance = vi.fn();
  let savedDraft = "seed";
  const createView = vi.fn(() => ({
    component: function Provider({ forwarding: next }: FrontendViewProps) {
      forwarding = next!;
      const [draft, setDraft] = useState(savedDraft);
      return (
        <>
          <h3>Real native provider</h3>
          <input
            aria-label="Provider draft"
            value={draft}
            onChange={(e) => {
              savedDraft = e.target.value;
              setDraft(savedDraft);
            }}
          />
          {next && <next.Entries />}
        </>
      );
    },
    captureState: () => ({ draft: savedDraft }),
    restoreState: (value: unknown) => {
      savedDraft = (value as { draft: string }).draft;
    },
    dispose: disposeInstance,
  }));
  const invoke = vi.fn(async (_command: string, { request }: { request: { action: string } }) => {
    if (request.action === "describeForwardingProvider") return descriptor;
    if (request.action === "openForwardingProvider")
      return { ...descriptor.view, token: "original-child" };
    return null;
  });
  const provider = createNativePluginViewClient(
    { windowId: "satellite", document: "document" },
    { invoke: invoke as never, load: async () => ({ activate, createView }), report: vi.fn() },
  );
  const mutation = vi.fn(async () => ({ id: "group" }));
  const refresh = vi.fn(async () => null);
  const client = {
    windowId: "satellite",
    pluginViews: () => provider,
    subscribeForwardingProvider: async () => () => {},
    forwardingMutation: mutation,
    action: refresh,
  } as unknown as PanelWindowClient;
  mock.views = { client };
  mock.entries.set("forwarding", record);
  usePanelWindows.setState({
    available: true,
    windowId: "satellite",
    snapshot: { windows: [], panels: staged ? [] : [lease], transfers: [] },
  });
  const tree = () => (
    <PanelViewStateScope controller={controller}>
      <WindowForwardingPanel client={client} record={record} data={data} />
    </PanelViewStateScope>
  );
  disposals.push(() => {
    provider.dispose();
    controller.dispose();
  });
  return {
    client,
    controller,
    lease,
    data,
    tree,
    createView,
    activate,
    disposeInstance,
    invoke,
    mutation,
    refresh,
    forwarding: () => forwarding,
    update: (next: Partial<WindowViewRecord>) => {
      record = { ...record, ...next };
      mock.entries.set("forwarding", record);
    },
  };
}
it("promotes a real staged provider without remounting its child/input or acquiring main stores and retires staged action callbacks", async () => {
  const f = fixture();
  const view = render(f.tree());
  fireEvent.click(screen.getByRole("button", { name: "Server" }));
  await screen.findByText("Real native provider");
  const old = f.forwarding();
  expect(old.capabilities.write).toBe(false);
  fireEvent.change(screen.getByLabelText("Provider draft"), {
    target: { value: "unsaved provider draft" },
  });
  act(() => {
    f.update({ staged: false, lease: f.lease });
    view.rerender(f.tree());
  });
  await waitFor(() => expect(f.forwarding().capabilities.write).toBe(true));
  expect(screen.getByLabelText("Provider draft")).toHaveProperty("value", "unsaved provider draft");
  expect(f.createView).toHaveBeenCalledOnce();
  expect(f.activate).not.toHaveBeenCalled();
  expect(() => old.requestAdd()).toThrow();
  fireEvent.click(screen.getByRole("button", { name: "New forwarding group" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Group name" }), {
    target: { value: "Native group" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() =>
    expect(f.mutation).toHaveBeenCalledExactlyOnceWith(f.lease, {
      operation: "saveGroup",
      hostId: "host",
      name: "Native group",
    }),
  );
  expect(f.refresh).toHaveBeenCalledWith(f.lease, { kind: "refreshForwarding" });
  expect(f.createView).toHaveBeenCalledOnce();
  view.unmount();
  await waitFor(() => expect(f.disposeInstance).toHaveBeenCalledOnce());
});
it("does not recreate factories on live model refresh or reuse a retired action generation", async () => {
  const f = fixture(false);
  const view = render(f.tree());
  fireEvent.click(screen.getByRole("button", { name: "Server" }));
  await screen.findByText("Real native provider");
  await waitFor(() => expect(f.forwarding().capabilities.write).toBe(true));
  const old = f.forwarding();
  f.data.groups = {
    ...f.data.groups,
    entries: [{ id: "empty", hostId: "host", name: "Empty", revision: "one" }],
  };
  view.rerender(f.tree());
  expect(f.createView).toHaveBeenCalledOnce();
  act(() => {
    f.update({ lease: { ...f.lease, generation: 8 } });
    view.rerender(f.tree());
  });
  expect(() => old.requestAdd()).toThrow();
  await waitFor(() => expect(f.forwarding().capabilities.write).toBe(true));
  expect(f.createView).toHaveBeenCalledOnce();
  expect(f.activate).not.toHaveBeenCalled();
  expect(f.mutation).not.toHaveBeenCalled();
});

it("captures and restores provider state, selected host and builtin editor fields without credentials or action authority", async () => {
  const f = fixture(false);
  const view = render(f.tree());
  fireEvent.click(screen.getByRole("button", { name: "Server" }));
  await screen.findByText("Real native provider");
  fireEvent.change(screen.getByLabelText("Provider draft"), {
    target: { value: "portable provider draft" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Add forward" }));
  const name = screen.getByRole("textbox", { name: "Name" });
  fireEvent.change(name, { target: { value: "Unsaved rule" } });
  const capsule = await f.controller.captureAsync();
  const wire = JSON.stringify(capsule);
  expect(wire).toContain("portable provider draft");
  expect(wire).toContain("Unsaved rule");
  expect(wire).not.toContain("original-child");
  expect(wire).not.toContain("document");
  view.unmount();
  const destination = fixture(true, capsule);
  render(destination.tree());
  await waitFor(() =>
    expect(screen.getByLabelText("Provider draft")).toHaveProperty(
      "value",
      "portable provider draft",
    ),
  );
  expect(screen.getByRole("textbox", { name: "Name" })).toHaveProperty("value", "Unsaved rule");
  expect(destination.createView).toHaveBeenCalledOnce();
  expect(destination.activate).not.toHaveBeenCalled();
  expect(destination.mutation).not.toHaveBeenCalled();
});

it("renders and edits builtin rules only after native discovery explicitly selects no provider", async () => {
  const f = fixture(false);
  f.invoke.mockImplementation(async () => null);
  render(f.tree());
  fireEvent.click(screen.getByRole("button", { name: "Server" }));
  await screen.findByText("No forwarding rules yet");
  expect(screen.queryByText("Real native provider")).toBeNull();
  expect(f.createView).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Add forward" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Name" }), {
    target: { value: "Builtin draft" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(f.mutation).toHaveBeenCalled());
  expect(f.mutation.mock.calls[0]).toEqual([
    f.lease,
    expect.objectContaining({
      operation: "save",
      rule: expect.objectContaining({ name: "Builtin draft", hostId: "host" }),
    }),
  ]);
  expect(f.activate).not.toHaveBeenCalled();
});
