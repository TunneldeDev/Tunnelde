import "@/i18n/i18n";
import { useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { PreviewBody } from "@/features/sftp/preview/PreviewBody";
import { WindowPreviewProvider } from "@/features/sftp/preview/WindowPreviewProvider";
import type { PreviewWindowData } from "@/features/sftp/preview/windowModel";
import { createPanelViewState, PanelViewStateScope } from "@/lib/panels/viewState";
import {
  createNativePluginViewClient,
  type NativePluginViewTarget,
} from "@/lib/panels/windowPluginClient";
import type { PanelWindowClient } from "@/lib/panels/windowClient";
import type { WindowProviderOwner } from "@/lib/panels/windowProviderSource";
import type { NativePreviewProviderDescriptor } from "@/lib/panels/windowProtocol";
import type { FrontendModule, FrontendViewProps } from "@/lib/extensions/uiSdk";
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  convertFileSrc: (id: string) => `https://native/${id}`,
}));
const disposals: (() => void)[] = [];
afterEach(() => {
  cleanup();
  for (const dispose of disposals.splice(0)) dispose();
  vi.restoreAllMocks();
});
function fixture() {
  const activate = vi.fn();
  let observed: FrontendViewProps["filePreview"];
  const restored = vi.fn(),
    disposed = vi.fn(),
    mountedBody = vi.fn();
  function Body() {
    const [count, setCount] = useState(0);
    mountedBody();
    return <button onClick={() => setCount(count + 1)}>Body count {count}</button>;
  }
  const createView = vi.fn(() => {
    let draft = "seed";
    return {
      component: function Provider({ filePreview }: FrontendViewProps) {
        observed = filePreview;
        const [text, setText] = useState(draft),
          [error, setError] = useState("");
        const Content = filePreview!.Body;
        return (
          <>
            <input
              aria-label="Provider draft"
              value={text}
              onChange={(e) => {
                draft = e.target.value;
                setText(draft);
              }}
            />
            <span>{filePreview!.snapshot.path}</span>
            <button
              onClick={() => {
                try {
                  Promise.resolve(filePreview!.retry()).catch((e) => setError(e.message));
                } catch (e) {
                  setError((e as Error).message);
                }
              }}
            >
              Provider retry
            </button>
            <p role="status">{error}</p>
            <Content />
          </>
        );
      },
      captureState: () => ({ draft }),
      restoreState(value: unknown) {
        restored(value);
        draft = (value as { draft: string }).draft;
      },
      dispose: disposed,
    };
  });
  const module: FrontendModule = { activate, createView };
  let descriptor: NativePreviewProviderDescriptor | null = {
    selectionRevision: 1,
    sourceKind: "remote",
    capabilities: { write: true },
    view: {
      pluginId: "qa-preview",
      runtimeId: "boot:1",
      generation: 1,
      viewId: "preview",
      entry: "index.mjs",
      sdkVersion: "0.1.0",
      title: "Preview",
      allowFloating: true,
    },
  };
  let serial = 0;
  let discoveryError = false;
  const invoke = vi.fn(async (_command: string, { request }: { request: { action: string } }) => {
    if (request.action === "describePreviewProvider") {
      if (discoveryError) throw new Error("panel is frozen");
      return structuredClone(descriptor);
    }
    if (request.action === "openPreviewProvider")
      return {
        token: `native-child-${++serial}`,
        pluginId: "qa-preview",
        runtimeId: "boot:1",
        generation: 1,
        entry: "index.mjs",
        sdkVersion: "0.1.0",
      };
    if (request.action === "submitPreviewProviderAction") return "receipt";
    return null;
  });
  const report = vi.fn();
  const native = createNativePluginViewClient(
    { windowId: "satellite", document: "private-document" },
    { invoke: invoke as never, load: async () => module, report },
  );
  disposals.push(() => native.dispose());
  let invalidated: (() => void) | undefined,
    current = true,
    valid = true;
  const receiveAction = vi.fn(async () => null);
  const client = {
    windowId: "satellite",
    pluginViews: () => native,
    receiveAction,
    subscribeForwardingProvider: async (fn: () => void) => {
      invalidated = fn;
      return () => {};
    },
  } as unknown as PanelWindowClient;
  let target: NativePluginViewTarget = { kind: "staged", id: "offer" };
  const owner: WindowProviderOwner = {
    client,
    target: () => target,
    check(mutation) {
      if (!current || (mutation && target.kind !== "owned"))
        throw new Error("panel.window.staleOwner");
    },
  };
  const data: PreviewWindowData = {
    snapshot: {
      id: "preview",
      attemptId: "attempt",
      revision: "revision",
      source: { kind: "remote", sessionId: "original-ssh" },
      path: "/original.txt",
      line: 0,
      column: 0,
      presentation: "docked",
      renderer: "text",
      providerId: null,
      providerCount: 0,
      state: "ready",
      errorCode: null,
    },
    providers: [],
    read: { status: "ready", content: "not in draft" },
  };
  const validate = () => {
    if (!valid) throw new Error("plugin.filePreview.changed");
  };
  const state = (initial?: unknown) => {
    const value = createPanelViewState(initial);
    disposals.push(value.dispose);
    return value;
  };
  const tree = (controller: ReturnType<typeof state>, value = data) => (
    <PanelViewStateScope controller={controller}>
      <PreviewBody attemptId={value.snapshot.attemptId}>
        <WindowPreviewProvider
          owner={owner}
          Body={Body}
          data={value}
          validate={validate}
          validateTarget={() => {}}
          visible
        />
      </PreviewBody>
    </PanelViewStateScope>
  );
  return {
    data,
    state,
    tree,
    activate,
    createView,
    restored,
    disposed,
    invoke,
    receiveAction,
    observed: () => observed!,
    discoveryFailure(value: boolean) {
      discoveryError = value;
      invalidated?.();
    },
    promote() {
      target = {
        kind: "owned",
        lease: { panelId: "filePreview", windowId: "satellite", generation: 2 },
      };
      invalidated?.();
    },
    revoke() {
      descriptor = { ...descriptor!, capabilities: { write: false } };
      invalidated?.();
    },
    replace() {
      valid = false;
    },
    retire() {
      current = false;
    },
    deselect() {
      descriptor = null;
      invalidated?.();
    },
  };
}
it("uses genuine preview factories, promotes the same Body, and restores private drafts without singleton replay", async () => {
  const f = fixture(),
    first = f.state();
  const ui = render(f.tree(first));
  await screen.findByLabelText("Provider draft");
  await first.waitReady(new AbortController().signal);
  fireEvent.click(screen.getByText("Body count 0"));
  fireEvent.click(screen.getByText("Provider retry"));
  await screen.findByText("panel.window.staleOwner");
  expect(f.receiveAction).not.toHaveBeenCalled();
  act(() => f.promote());
  fireEvent.click(screen.getByText("Provider retry"));
  await waitFor(() => expect(f.receiveAction).toHaveBeenCalledOnce());
  expect(f.invoke).toHaveBeenCalledWith(
    "panel_window_plugin_view",
    expect.objectContaining({
      request: {
        action: "submitPreviewProviderAction",
        token: "native-child-1",
        lease: { panelId: "filePreview", windowId: "satellite", generation: 2 },
        id: "preview",
        attemptId: "attempt",
        revision: "revision",
        command: { operation: "retry" },
      },
    }),
  );
  ui.rerender(
    f.tree(first, { ...f.data, snapshot: { ...f.data.snapshot, revision: "next-revision" } }),
  );
  expect(screen.getByText("Body count 1")).toBeTruthy();
  expect(f.createView).toHaveBeenCalledOnce();
  fireEvent.change(screen.getByLabelText("Provider draft"), {
    target: { value: "retained draft" },
  });
  const capsule = await first.captureAsync();
  expect(JSON.stringify(capsule)).not.toMatch(
    /private-document|native-child|original-ssh|not in draft/,
  );
  ui.unmount();
  const second = f.state(capsule);
  render(f.tree(second));
  await screen.findByDisplayValue("retained draft");
  await second.waitReady(new AbortController().signal);
  expect(f.restored).toHaveBeenCalledWith({ draft: "retained draft" });
  expect(f.activate).not.toHaveBeenCalled();
});
it("rejects retained frames after target replacement and permission revocation", async () => {
  const f = fixture();
  f.promote();
  render(f.tree(f.state()));
  await screen.findByLabelText("Provider draft");
  const retained = f.observed();
  f.replace();
  expect(() => retained.retry()).toThrow("changed");
  expect(f.receiveAction).not.toHaveBeenCalled();
  act(() => f.revoke());
  await waitFor(() => expect(f.createView).toHaveBeenCalledTimes(2));
  expect(() => f.observed().retry()).toThrow();
  expect(f.receiveAction).not.toHaveBeenCalled();
});
it("cannot acknowledge a restored provider draft as builtin after deselection", async () => {
  const f = fixture(),
    first = f.state();
  const ui = render(f.tree(first));
  await screen.findByLabelText("Provider draft");
  const capsule = await first.captureAsync();
  ui.unmount();
  f.deselect();
  const destination = f.state(capsule);
  render(f.tree(destination));
  await screen.findByText("Body count 0");
  await expect(destination.captureAsync()).rejects.toThrow();
  expect(f.createView).toHaveBeenCalledOnce();
});

it("retains the same provider and nested draft while frozen discovery temporarily fails", async () => {
  const f = fixture();
  f.promote();
  const first = f.state();
  const ui = render(f.tree(first));
  await screen.findByLabelText("Provider draft");
  fireEvent.change(screen.getByLabelText("Provider draft"), {
    target: { value: "never lose this draft" },
  });
  act(() => f.discoveryFailure(true));
  await screen.findByRole("alert");
  expect(screen.getByDisplayValue("never lose this draft")).toBeTruthy();
  act(() => f.discoveryFailure(false));
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  const state = await first.captureAsync();
  ui.unmount();
  const returning = f.state(state);
  render(f.tree(returning));
  await screen.findByDisplayValue("never lose this draft");
  expect(f.createView).toHaveBeenCalledTimes(2);
});
