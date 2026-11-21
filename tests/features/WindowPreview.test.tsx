import "@/i18n/i18n";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { panelActionsContainer } from "@/components/layout/panelSlots";
import { WindowPreview } from "@/features/sftp/preview/WindowPreview";
import { createPanelViewState, PanelViewStateScope } from "@/lib/panels/viewState";
import type { WindowProviderOwner } from "@/lib/panels/windowProviderSource";
import type { NativePluginViewTarget } from "@/lib/panels/windowPluginClient";
import type { PreviewWindowData } from "@/features/sftp/preview/windowModel";
import type { PanelWindowClient } from "@/lib/panels/windowClient";
vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (id: string) => `preview://localhost/${id}`,
  invoke: vi.fn(),
}));
const disposals: (() => void)[] = [];
afterEach(() => {
  cleanup();
  for (const dispose of disposals.splice(0)) dispose();
  vi.restoreAllMocks();
});
function fixture(renderer: "text" | "image" = "text", staged = false) {
  const lease = { panelId: "filePreview", windowId: "satellite", generation: 2 };
  let target: NativePluginViewTarget = staged
    ? { kind: "staged", id: "offer" }
    : { kind: "owned", lease };
  let current = true,
    frozen = false;
  const dispose = vi.fn();
  const openPreviewHandle = vi.fn(async (): Promise<{ id: string; dispose(): void }> => ({
    id: "panel-private-display",
    dispose,
  }));
  const action = vi.fn(async () => null);
  const describePreviewProvider = vi.fn(async () => null);
  const client = {
    windowId: "satellite",
    openPreviewHandle,
    action,
    pluginViews: () => ({ describePreviewProvider }),
    subscribeForwardingProvider: async () => () => {},
  } as unknown as PanelWindowClient;
  const owner: WindowProviderOwner = {
    client,
    target: () => {
      if (!current) throw new Error("retired");
      return target;
    },
    check: (mutation) => {
      if (!current || (mutation && (target.kind === "staged" || frozen)))
        throw new Error("retired");
    },
  };
  const data: PreviewWindowData = {
    snapshot: {
      id: "preview-target",
      attemptId: "read-attempt",
      revision: "current-revision",
      source: { kind: "remote", sessionId: "original-session" },
      path: renderer === "text" ? "/document.txt" : "/photo.png",
      line: 0,
      column: 0,
      presentation: "docked",
      renderer,
      providerId: renderer === "image" ? "images:png" : null,
      providerCount: 0,
      state: "loading",
      errorCode: null,
    },
    providers: [],
    read:
      renderer === "text"
        ? { status: "ready", content: "same remote contents", encoding: "utf-8" }
        : { status: "ready", resource: { id: "read-attempt", renderer: "image", size: 10 } },
  };
  const controller = createPanelViewState();
  disposals.push(controller.dispose);
  const display = (active: boolean, value = data) => (
    <PanelViewStateScope controller={controller}>
      <WindowPreview owner={owner} data={value} active={active} />
    </PanelViewStateScope>
  );
  return {
    owner,
    data,
    client,
    action,
    dispose,
    openPreviewHandle,
    describePreviewProvider,
    controller,
    display,
    promote() {
      target = { kind: "owned", lease };
    },
    freeze() {
      frozen = true;
    },
    retire() {
      current = false;
    },
  };
}
it("renders injected remote text and submits exact target/revision reports only after committed ownership", async () => {
  const f = fixture("text", true);
  const view = render(f.display(false));
  await screen.findByDisplayValue("same remote contents");
  expect(f.openPreviewHandle).not.toHaveBeenCalled();
  expect(f.action).not.toHaveBeenCalled();
  f.promote();
  view.rerender(f.display(true));
  await waitFor(() => expect(f.action).toHaveBeenCalledOnce());
  expect(f.action).toHaveBeenCalledWith(
    expect.objectContaining({ generation: 2 }),
    {
      kind: "preview",
      id: "preview-target",
      attemptId: "read-attempt",
      revision: "current-revision",
      command: { operation: "ready" },
    },
    expect.any(AbortSignal),
  );
  view.rerender(
    f.display(true, {
      ...f.data,
      snapshot: { ...f.data.snapshot, revision: "ready-revision", state: "ready" },
    }),
  );
  await act(async () => {});
  expect(f.action).toHaveBeenCalledOnce(); // Reporting readiness cannot feed itself forever.
});
it("promotes the SAME scoped image handle and DOM without reopening, and cleans only the display on retirement", async () => {
  const f = fixture("image", true);
  const view = render(f.display(false));
  const image = await screen.findByRole("img", { name: "photo.png" });
  expect(image.getAttribute("src")).toBe("preview://localhost/panel-private-display");
  expect(f.openPreviewHandle).toHaveBeenCalledWith(
    { kind: "staged", id: "offer" },
    "read-attempt",
    expect.any(AbortSignal),
  );
  expect(() => f.controller.capture()).toThrow();
  fireEvent.load(image);
  expect(() => f.controller.capture()).not.toThrow();
  f.promote();
  view.rerender(f.display(true));
  expect(await screen.findByRole("img", { name: "photo.png" })).toBe(image);
  expect(f.openPreviewHandle).toHaveBeenCalledOnce();
  f.retire();
  view.unmount();
  expect(f.dispose).toHaveBeenCalled();
});
it("does not acknowledge a spinner before the scoped native attachment is actually admitted", async () => {
  const f = fixture("image", true);
  let resolve!: (handle: { id: string; dispose(): void }) => void;
  f.openPreviewHandle.mockReturnValue(
    new Promise((done) => {
      resolve = done;
    }),
  );
  const view = render(f.display(false));
  await waitFor(() => expect(f.describePreviewProvider).toHaveBeenCalled());
  expect(screen.queryByRole("img")).toBeNull();
  expect(() => f.controller.capture()).toThrow();
  const dispose = vi.fn();
  view.unmount();
  await act(async () => {
    resolve({ id: "late-display", dispose });
  });
  expect(dispose).toHaveBeenCalled();
});
it("denies stale or frozen renderer actions rather than operating on main's current file", async () => {
  const f = fixture("text");
  document.body.append(panelActionsContainer("filePreview"));
  render(f.display(true));
  await screen.findByRole("textbox");
  f.action.mockClear();
  f.freeze();
  fireEvent.click(screen.getByRole("button", { name: "Edit text" }));
  await act(async () => {});
  expect(f.action).not.toHaveBeenCalled();
});
