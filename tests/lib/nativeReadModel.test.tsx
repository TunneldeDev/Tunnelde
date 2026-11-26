import "@/i18n/i18n";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useNativeReadModel } from "@/lib/panels/useNativeReadModel";
import { createPanelViewState } from "@/lib/panels/viewState";
import type { NativeViewProps } from "@/lib/panels/useNativeReadModel";
import type { NativePanelSnapshot } from "@/lib/panels/windowProtocol";
import { useToasts } from "@/store/toasts";
import { getLocalDiagnostics, clearLocalDiagnostics } from "@/lib/diagnostics";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => true) }));
vi.mock("@/lib/prefs/appearance", () => ({
  applyAppearance: vi.fn(),
  observeSystemAppearance: () => vi.fn(),
}));
afterEach(() => {
  useToasts.setState({ items: [] });
  clearLocalDiagnostics();
});
function fixture(staged = true) {
  let refresh = () => {};
  const control = vi.fn();
  const snapshot = vi.fn<() => Promise<NativePanelSnapshot>>();
  const props = {
    client: {
      control,
      snapshot,
      subscribe: vi.fn(async (changed: () => void) => {
        refresh = changed;
        return vi.fn();
      }),
    },
    record: {
      key: "offer",
      panelId: "editor-view:test",
      staged,
      controller: createPanelViewState(),
      ...(!staged
        ? { lease: { panelId: "editor-view:test", windowId: "satellite", generation: 2 } }
        : {}),
    },
    presented: vi.fn(),
  } as unknown as NativeViewProps;
  return { props, control, snapshot, refresh: () => refresh() };
}
it("does not toast when commit retires a staged editor read before React promotion", async () => {
  const f = fixture();
  let reject!: (value: unknown) => void;
  f.control.mockImplementationOnce(
    () =>
      new Promise((_done, fail) => {
        reject = fail;
      }),
  );
  f.snapshot.mockResolvedValue({
    windows: [],
    transfers: [],
    panels: [{ panelId: f.props.record.panelId, windowId: "satellite", generation: 3 }],
  });
  const hook = renderHook((props) => useNativeReadModel(props), { initialProps: f.props });
  await waitFor(() => expect(f.control).toHaveBeenCalledOnce());
  await act(async () => reject({ code: "validation", message: "transfer expired" }));
  expect(f.snapshot).toHaveBeenCalledOnce();
  expect(useToasts.getState().items).toHaveLength(0);
  f.control.mockResolvedValue({ appearance: {}, language: "en-US", platform: "macos" });
  hook.rerender({
    ...f.props,
    record: {
      ...f.props.record,
      staged: false,
      lease: { panelId: f.props.record.panelId, windowId: "satellite", generation: 3 },
    },
  });
  await waitFor(() => expect(hook.result.current).toMatchObject({ platform: "macos" }));
  expect(f.control).toHaveBeenLastCalledWith({
    action: "readModel",
    lease: expect.objectContaining({ generation: 3 }),
  });
});
it("preserves a real staged read failure while the offer still exists", async () => {
  const f = fixture();
  f.control.mockRejectedValue({ code: "validation", message: "transfer expired" });
  f.snapshot.mockResolvedValue({
    windows: [],
    panels: [],
    transfers: [
      {
        offer: {
          id: "offer",
          targetWindow: "satellite",
          lease: { panelId: f.props.record.panelId, windowId: "main", generation: 1 },
        },
        ready: false,
      },
    ],
  });
  renderHook(() => useNativeReadModel(f.props));
  await waitFor(() => expect(useToasts.getState().items).toHaveLength(1));
  expect(getLocalDiagnostics()[0]?.event).toMatchObject({
    operation: "panel_window_control.stagedModel",
    message: "transfer expired",
    ipc: { action: "stagedModel", panelKind: "editor-view" },
  });
});
it("ignores a delayed source read only after native confirms the lease was retired", async () => {
  const f = fixture(false);
  f.control.mockRejectedValue({ code: "validation", message: "stale panel owner" });
  f.snapshot.mockResolvedValue({ windows: [], panels: [], transfers: [] });
  renderHook(() => useNativeReadModel(f.props));
  await waitFor(() => expect(f.snapshot).toHaveBeenCalledOnce());
  expect(useToasts.getState().items).toHaveLength(0);
});
it("reports unrelated editor failures without treating them as ownership transitions", async () => {
  const f = fixture();
  f.control.mockRejectedValue({ code: "io", message: "disk failed" });
  renderHook(() => useNativeReadModel(f.props));
  await waitFor(() => expect(useToasts.getState().items).toHaveLength(1));
  expect(f.snapshot).not.toHaveBeenCalled();
});
