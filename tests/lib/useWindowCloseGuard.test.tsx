import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import type * as IpcModule from "@/lib/api/ipc";

const mocks = vi.hoisted(() => ({
  native: vi.fn(),
  invoke: vi.fn(),
  listen: vi.fn(),
  stop: vi.fn(),
  toast: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));
vi.mock("@/lib/api/ipc", async (original) => ({
  ...(await original<typeof IpcModule>()),
  isTauri: mocks.native,
}));
vi.mock("@/store/toasts", () => ({ toast: mocks.toast }));
import "@/i18n/i18n";
import type { AppInfo } from "@/lib/api/types";
import { DEFAULT_SETTINGS } from "@/lib/prefs/defaults";
import { useWindowCloseGuard } from "@/lib/session/useWindowCloseGuard";
import { prepareWindowReload } from "@/lib/session/reload";
import { useDialogs } from "@/store/dialogs";
import { useEditors, type EditorEntry } from "@/store/editors";
import { useSettings } from "@/store/settings";

const draft = (tabId = "draft"): EditorEntry => ({
  tabId,
  sessionId: "session",
  path: `/etc/${tabId}.conf`,
  name: `${tabId}.conf`,
  content: "edited",
  baseline: "original",
  loading: false,
  saving: false,
  error: null,
});
async function mount() {
  const rendered = renderHook(useWindowCloseGuard);
  await waitFor(() =>
    expect(mocks.invoke).toHaveBeenCalledWith("main_window_close_guard_claim", {
      owner: expect.any(String),
    }),
  );
  return rendered;
}
const owner = () =>
  mocks.invoke.mock.calls.find(([method]) => method === "main_window_close_guard_claim")![1]
    .owner as string;
async function requestClose(payload = owner()) {
  await act(async () => mocks.listen.mock.calls[0]![1]({ payload }));
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.native.mockReturnValue(true);
  mocks.invoke.mockResolvedValue(undefined);
  mocks.stop.mockResolvedValue(undefined);
  mocks.listen.mockResolvedValue(mocks.stop);
  useSettings.setState({
    settings: { ...DEFAULT_SETTINGS, closeToTray: false },
    info: { os: "windows" } as AppInfo,
  });
  useEditors.setState({ entries: {} });
  useDialogs.getState().close();
});
it("registers only an ordinary document-scoped event and ignores stale document close requests", async () => {
  await mount();
  expect(mocks.listen).toHaveBeenCalledWith("ui://close-requested", expect.any(Function));
  await requestClose("previous-document");
  expect(mocks.invoke).not.toHaveBeenCalledWith(
    "main_window_close_guard_finish",
    expect.anything(),
  );
  await requestClose();
  expect(mocks.invoke).toHaveBeenCalledWith("main_window_close_guard_finish", { owner: owner() });
});
it("retains drafts on cancel and repeated close then approves only an explicit discard", async () => {
  useEditors.setState({
    entries: { draft: draft(), second: { ...draft("second"), saving: true } },
  });
  await mount();
  await requestClose();
  const first = useDialogs.getState().dialog;
  if (first.kind !== "confirm") throw Error("Missing confirmation");
  expect(first.body).toContain("draft.conf, second.conf");
  await requestClose();
  expect(useDialogs.getState().dialog).toBe(first);
  useDialogs.getState().close();
  expect(useEditors.getState().entries.draft?.content).toBe("edited");
  expect(mocks.invoke).not.toHaveBeenCalledWith(
    "main_window_close_guard_finish",
    expect.anything(),
  );
  await requestClose();
  const second = useDialogs.getState().dialog;
  if (second.kind !== "confirm") throw Error("Missing confirmation");
  await act(async () => second.onConfirm());
  expect(mocks.invoke).toHaveBeenCalledWith("main_window_close_guard_finish", { owner: owner() });
});
it("waits for native release before reload and blocks reload if release fails", async () => {
  const rendered = await mount();
  let finish!: () => void;
  mocks.invoke.mockImplementation((method) =>
    method === "main_window_close_guard_release"
      ? new Promise<void>((resolve) => {
          finish = resolve;
        })
      : Promise.resolve(),
  );
  let ready = false;
  const preparing = prepareWindowReload().then(() => {
    ready = true;
  });
  await waitFor(() => expect(finish).toBeTypeOf("function"));
  expect(ready).toBe(false);
  await act(async () => {
    finish();
    await preparing;
  });
  expect(ready).toBe(true);
  expect(mocks.stop).toHaveBeenCalledOnce();
  rendered.unmount();
  expect(mocks.stop).toHaveBeenCalledOnce();
});
it("retains close protection and drafts after failed release or failed close", async () => {
  await mount();
  mocks.invoke.mockImplementation((method) =>
    method === "main_window_close_guard_release"
      ? Promise.reject(Error("release failed"))
      : Promise.resolve(),
  );
  await expect(prepareWindowReload()).rejects.toThrow("release failed");
  useEditors.setState({ entries: { draft: draft() } });
  await requestClose();
  let confirmation = useDialogs.getState().dialog;
  if (confirmation.kind !== "confirm") throw Error("Missing confirmation");
  const discard = confirmation.onConfirm;
  mocks.invoke.mockRejectedValueOnce(Error("close failed"));
  await act(async () => discard());
  expect(mocks.toast).toHaveBeenCalled();
  expect(useEditors.getState().entries.draft?.content).toBe("edited");
  useDialogs.getState().close();
  await requestClose();
  confirmation = useDialogs.getState().dialog;
  expect(confirmation.kind).toBe("confirm");
});
it("does not ask to discard for macOS or tray hiding", async () => {
  await mount();
  useEditors.setState({ entries: { draft: draft() } });
  useSettings.setState({ info: { os: "macos" } as AppInfo });
  await requestClose();
  useSettings.setState({
    info: { os: "windows" } as AppInfo,
    settings: { ...DEFAULT_SETTINGS, closeToTray: true },
  });
  await requestClose();
  expect(useDialogs.getState().dialog.kind).toBe("none");
  expect(mocks.invoke).not.toHaveBeenCalledWith(
    "main_window_close_guard_finish",
    expect.anything(),
  );
});
it("waits for pending registration during reload and cleans registration completing after unmount", async () => {
  let finish!: (stop: () => Promise<void>) => void;
  mocks.listen.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const rendered = renderHook(useWindowCloseGuard);
  let ready = false;
  const preparing = prepareWindowReload().then(() => {
    ready = true;
  });
  await act(async () => {});
  expect(ready).toBe(false);
  await act(async () => {
    finish(mocks.stop);
    await preparing;
  });
  expect(ready).toBe(true);
  rendered.unmount();
  expect(mocks.stop).toHaveBeenCalledOnce();
  vi.clearAllMocks();
  mocks.listen.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const late = renderHook(useWindowCloseGuard);
  late.unmount();
  await act(async () => finish(mocks.stop));
  expect(mocks.invoke).toHaveBeenCalledWith("main_window_close_guard_release", expect.anything());
  expect(mocks.stop).toHaveBeenCalledOnce();
});
it("does not subscribe in browser mode and cleans an event listener if native claim fails", async () => {
  mocks.native.mockReturnValue(false);
  const browser = renderHook(useWindowCloseGuard);
  expect(mocks.listen).not.toHaveBeenCalled();
  browser.unmount();
  mocks.native.mockReturnValue(true);
  mocks.invoke.mockRejectedValueOnce(Error("claim failed"));
  renderHook(useWindowCloseGuard);
  await waitFor(() => expect(mocks.stop).toHaveBeenCalledOnce());
  expect(mocks.toast).toHaveBeenCalled();
});
