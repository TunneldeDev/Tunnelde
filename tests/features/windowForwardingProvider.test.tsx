import "@/i18n/i18n";
import { Component, StrictMode, useState, type ReactNode } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import {
  openWindowForwardingProviderView,
  WindowForwardingProviderScope,
} from "@/features/forwarding/runtime/windowProvider";
import { createWindowForwardingActions } from "@/features/forwarding/runtime/windowActions";
import { createNativePluginViewClient } from "@/lib/panels/windowPluginClient";
import { createResourceScope } from "@/lib/extensions/resourceScope";
import { createForwardingContext } from "@/lib/extensions/forwarding/context";
import type { ForwardingAuthority } from "@/lib/extensions/forwarding/authority";
import type { FrontendForwarding, FrontendViewProps } from "@/lib/extensions/uiSdkContract";
import type { NativeForwardingProviderDescriptor } from "@/lib/panels/windowProtocol";
import type { PanelWindowClient } from "@/lib/panels/windowClient";
const raw = vi.hoisted(() => ({
  invoke: vi.fn(() => {
    throw new Error("raw main IPC forbidden");
  }),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: raw.invoke,
  convertFileSrc: (token: string) => `https://native-child/${token}`,
}));
const disposals: (() => void)[] = [];
afterEach(() => {
  cleanup();
  for (const dispose of disposals.splice(0)) dispose();
  expect(raw.invoke).not.toHaveBeenCalled();
  vi.clearAllMocks();
});
const lease = { panelId: "forwarding", windowId: "satellite", generation: 7 };
const target = { kind: "owned" as const, lease };
function fixture(write = true) {
  const descriptor: NativeForwardingProviderDescriptor = {
    selectionRevision: 9,
    capabilities: { write },
    view: {
      pluginId: "selected",
      runtimeId: "runtime",
      generation: 5,
      viewId: "forwards",
      entry: "index.mjs",
      sdkVersion: "0.1.0",
      title: "Selected forwarding",
      allowFloating: true,
    },
  };
  const session = { ...descriptor.view, token: "original-native-child" };
  const exposed: FrontendForwarding[] = [];
  let authority: ForwardingAuthority | undefined;
  let draft = "seed";
  const disposeInstance = vi.fn();
  const capture = vi.fn(() => ({ draft }));
  const restore = vi.fn((value: unknown) => {
    draft = (value as { draft: string }).draft;
  });
  const activate = vi.fn();
  const component = vi.fn((props: FrontendViewProps) => {
    exposed.push(props.forwarding!);
    const [text, setText] = useState(draft);
    return (
      <input
        aria-label="Provider draft"
        value={text}
        onChange={(event) => {
          draft = event.target.value;
          setText(draft);
        }}
      />
    );
  });
  const createView = vi.fn(() => ({
    component,
    captureState: capture,
    restoreState: restore,
    dispose: disposeInstance,
  }));
  const load = vi.fn(async () => ({ activate, createView }));
  const invoke = vi.fn(async (_command: string, args: { request: { action: string } }) =>
    args.request.action === "openForwardingProvider" ? session : null,
  );
  const client = createNativePluginViewClient(
    { windowId: "satellite", document: "document" },
    { invoke: invoke as never, load, report: vi.fn() },
  );
  const parent = createResourceScope({ report: vi.fn() });
  let valid = true;
  const check = vi.fn(() => {
    if (!valid) throw new Error("original selection retired");
  });
  const builtin = vi.fn(() => {
    throw new Error("builtin fallback forbidden");
  });
  const service = createWindowForwardingActions(
    { forwardingMutation: builtin } as unknown as PanelWindowClient,
    lease,
    { check, refresh: vi.fn(), report: vi.fn() },
  );
  disposals.push(() => {
    parent.dispose();
    service.dispose();
    client.dispose();
  });
  const actions = {
    validate: () => true,
    refresh: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    requestAdd: vi.fn((value: ForwardingAuthority) => {
      authority = value;
    }),
    requestEdit: vi.fn(),
    requestRemove: vi.fn(),
    requestDisconnect: vi.fn(),
  };
  const context = {
    Entries: () => <p>Native rows</p>,
    ...createForwardingContext(
      {
        hostId: "host",
        title: "Server",
        revision: "frame",
        total: 1,
        connected: true,
        busy: false,
        editing: false,
        error: null,
      },
      [
        {
          id: "rule",
          hostId: "host",
          name: "Database",
          mode: "local",
          bindHost: "127.0.0.1",
          bindPort: 8080,
          targetHost: "localhost",
          targetPort: 80,
          revision: "revision",
          active: false,
          runtimeId: null,
        },
      ],
      check,
      actions,
    ),
  };
  const owner = { service, check };
  const open = (state?: { value: unknown }, requestedTarget = target) =>
    openWindowForwardingProviderView({
      client,
      target: requestedTarget,
      descriptor,
      hostId: "host",
      parent,
      check,
      state,
    });
  return {
    descriptor,
    session,
    client,
    parent,
    service,
    owner,
    context,
    actions,
    check,
    builtin,
    invoke,
    load,
    activate,
    createView,
    component,
    capture,
    restore,
    disposeInstance,
    exposed,
    open,
    authority: () => authority!,
    retire: () => {
      valid = false;
    },
  };
}
function viewOf(
  mounted: Awaited<ReturnType<typeof openWindowForwardingProviderView>>,
  f: ReturnType<typeof fixture>,
  owner = f.owner,
) {
  const View = mounted.component;
  return (
    <WindowForwardingProviderScope value={{ owner, context: f.context }}>
      <View pluginId="selected" viewId="forwards" visible resources={mounted.resources} />
    </WindowForwardingProviderScope>
  );
}
it("loads only the selected native child and maps all write continuations to that exact attachment", async () => {
  const f = fixture();
  const mounted = await f.open({ value: { draft: "restored" } });
  render(viewOf(mounted, f));
  expect(screen.getByRole("textbox")).toHaveProperty("value", "restored");
  expect(f.activate).not.toHaveBeenCalled();
  expect(f.createView).toHaveBeenCalledOnce();
  expect(f.restore).toHaveBeenCalledExactlyOnceWith({ draft: "restored" });
  const api = f.exposed.at(-1)!;
  expect(api.capabilities.write).toBe(true);
  expect(api.read({ revision: "frame" }).items[0]?.id).toBe("rule");
  api.requestAdd();
  expect(f.actions.requestAdd).toHaveBeenCalledOnce();
  expect(f.service.providerFor(f.authority())).toEqual({
    client: f.client,
    token: "original-native-child",
  });
  await expect(f.authority().origin()).rejects.toThrow("unsupportedView");
  await f.service.actions.save(
    {
      id: "",
      hostId: "host",
      name: "Saved",
      mode: "local",
      bindHost: "127.0.0.1",
      bindPort: 8081,
      targetHost: "localhost",
      targetPort: 80,
    },
    undefined,
    f.authority(),
  );
  expect(f.invoke).toHaveBeenLastCalledWith(
    "panel_window_plugin_view",
    expect.objectContaining({
      document: "document",
      request: expect.objectContaining({
        action: "forwarding",
        token: "original-native-child",
        lease,
        request: expect.objectContaining({ operation: "save" }),
      }),
    }),
  );
  expect(f.builtin).not.toHaveBeenCalled();
  expect(JSON.stringify(api)).not.toContain("original-native-child");
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "private draft" } });
  expect(await mounted.captureState()).toEqual({ draft: "private draft" });
});
it("snapshots read-only grant hints and does not promote declared or mutated metadata into write access", async () => {
  const f = fixture(false);
  const mounted = await f.open();
  f.descriptor.capabilities.write = true;
  render(viewOf(mounted, f));
  const api = f.exposed.at(-1)!;
  expect(api.capabilities.write).toBe(false);
  expect(api.read({ revision: "frame" }).items).toHaveLength(1);
  for (const call of [
    () => api.start("rule"),
    () => api.startAll(),
    () => api.stop("rule"),
    () => api.requestAdd(),
    () => api.requestEdit("rule"),
    () => api.requestRemove("rule"),
    () => api.requestDisconnect(),
  ])
    expect(call).toThrow("permissionDenied");
  expect(f.actions.requestAdd).not.toHaveBeenCalled();
  expect(f.builtin).not.toHaveBeenCalled();
});
it("promotes the same child and draft from staged reads to a fresh action owner without reviving staged callbacks", async () => {
  const f = fixture();
  const mounted = await f.open();
  const staged = {
    check: vi.fn((mutation: boolean) => {
      if (mutation) throw new Error("staged owner");
    }),
  };
  const View = mounted.component;
  const tree = (owner: typeof staged | typeof f.owner) => (
    <WindowForwardingProviderScope value={{ owner, context: f.context }}>
      <View pluginId="selected" viewId="forwards" visible />
    </WindowForwardingProviderScope>
  );
  const ui = render(tree(staged));
  const input = screen.getByRole("textbox");
  const before = f.exposed.at(-1)!;
  expect(before.capabilities.write).toBe(false);
  expect(before.read({ revision: "frame" }).items).toHaveLength(1);
  expect(() => before.requestAdd()).toThrow("staged owner");
  fireEvent.change(input, { target: { value: "staged private draft" } });
  ui.rerender(tree(f.owner));
  expect(screen.getByRole("textbox")).toBe(input);
  expect(input).toHaveProperty("value", "staged private draft");
  expect(f.createView).toHaveBeenCalledOnce();
  expect(
    f.invoke.mock.calls.filter(([, args]) => args.request.action === "openForwardingProvider"),
  ).toHaveLength(1);
  expect(() => before.requestAdd()).toThrow("expired");
  expect(() => before.read({ revision: "frame" })).toThrow("expired");
  const after = f.exposed.at(-1)!;
  expect(after.capabilities.write).toBe(true);
  after.requestAdd();
  expect(f.service.providerFor(f.authority())?.token).toBe("original-native-child");
});
it("retires original callbacks on owner replacement even if the old action service still exists", async () => {
  const f = fixture();
  const mounted = await f.open();
  const ui = render(viewOf(mounted, f));
  const original = f.exposed.at(-1)!;
  original.requestAdd();
  const authority = f.authority();
  const owner = { ...f.owner };
  ui.rerender(viewOf(mounted, f, owner));
  expect(() => original.requestAdd()).toThrow("expired");
  expect(() => authority.authorize()).toThrow("expired");
  f.exposed.at(-1)!.requestAdd();
  expect(f.authority()).not.toBe(authority);
});
it("does not reacquire or activate on frame updates, hidden rendering or StrictMode effect probes", async () => {
  const f = fixture();
  const mounted = await f.open();
  const View = mounted.component;
  const ui = render(<StrictMode>{viewOf(mounted, f)}</StrictMode>);
  const input = screen.getByRole("textbox");
  const next = { ...f.context, snapshot: { ...f.context.snapshot, title: "Updated" } };
  ui.rerender(
    <StrictMode>
      <WindowForwardingProviderScope value={{ owner: f.owner, context: next }}>
        <View pluginId="selected" viewId="forwards" visible={false} />
      </WindowForwardingProviderScope>
    </StrictMode>,
  );
  expect(screen.getByRole("textbox")).toBe(input);
  expect(f.createView).toHaveBeenCalledOnce();
  expect(f.activate).not.toHaveBeenCalled();
  expect(f.exposed.at(-1)?.snapshot.title).toBe("Updated");
});
it("denies all retained callbacks after selection retirement or view disposal, without main fallback", async () => {
  const f = fixture();
  const mounted = await f.open();
  const ui = render(viewOf(mounted, f));
  const api = f.exposed.at(-1)!;
  api.requestAdd();
  const authority = f.authority();
  f.retire();
  expect(() => api.read({ revision: "frame" })).toThrow("original selection retired");
  expect(() => authority.authorize()).toThrow("original selection retired");
  ui.unmount();
  mounted.dispose();
  await vi.waitFor(() => expect(f.disposeInstance).toHaveBeenCalledOnce());
  expect(() => api.requestAdd()).toThrow();
  expect(f.builtin).not.toHaveBeenCalled();
  await vi.waitFor(() =>
    expect(f.invoke.mock.calls.filter(([, args]) => args.request.action === "close")).toHaveLength(
      1,
    ),
  );
});
it("closes a child whose import completes after the original scope was retired", async () => {
  const f = fixture();
  let release!: () => void;
  f.load.mockImplementationOnce(
    () =>
      new Promise((done) => {
        release = () => done({ activate: f.activate, createView: f.createView });
      }),
  );
  const pending = f.open();
  const rejected = expect(pending).rejects.toThrow();
  await vi.waitFor(() => expect(f.load).toHaveBeenCalledOnce());
  f.parent.dispose();
  release();
  await rejected;
  await vi.waitFor(() =>
    expect(f.invoke.mock.calls.filter(([, args]) => args.request.action === "close")).toHaveLength(
      1,
    ),
  );
  expect(f.createView).not.toHaveBeenCalled();
  expect(f.activate).not.toHaveBeenCalled();
});
it("never mounts a provider component against a different host's display context", async () => {
  const f = fixture();
  const mounted = await f.open();
  class Boundary extends Component<{ children: ReactNode }, { error: boolean }> {
    override state = { error: false };
    static getDerivedStateFromError() {
      return { error: true };
    }
    override render() {
      return this.state.error ? <p role="alert">Wrong host denied</p> : this.props.children;
    }
  }
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const View = mounted.component;
    render(
      <Boundary>
        <WindowForwardingProviderScope
          value={{
            owner: f.owner,
            context: { ...f.context, snapshot: { ...f.context.snapshot, hostId: "foreign" } },
          }}
        >
          <View pluginId="selected" viewId="forwards" visible />
        </WindowForwardingProviderScope>
      </Boundary>,
    );
    expect(screen.getByRole("alert")).toHaveProperty("textContent", "Wrong host denied");
    expect(f.component).not.toHaveBeenCalled();
  } finally {
    error.mockRestore();
  }
});
