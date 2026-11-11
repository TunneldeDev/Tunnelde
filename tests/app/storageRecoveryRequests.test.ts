import { beforeEach, afterEach, it, expect, vi } from "vitest";
import { runPluginWorkspaceRequest, wirePluginWorkspaceBridge } from "@/app/pluginWorkspaceBridge";
import { storageRecoveryReview } from "@/app/plugins/storageRecoveryRequests";
import { useDialogs } from "@/store/dialogs";
import { usePlugins } from "@/store/plugins";
import type { PluginInfo } from "@/lib/api/types";
import i18n from "@/i18n/i18n";
const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  handlers: new Map<string, (event: { payload: unknown }) => void>(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (name: string, handler: (event: { payload: unknown }) => void) => {
    mocks.handlers.set(name, handler);
    return () => mocks.handlers.delete(name);
  },
}));
const params = () => ({
  snapshot: {
    version: 1,
    revision: "r",
    locations: [
      "database",
      "plugins",
      "pluginData",
      "keys",
      "runtimes",
      "cache",
      "logs",
      "runners",
    ].map((category) => ({
      category,
      path: `C:/old/${category}`,
      defaultPath: `C:/old/${category}`,
      overridden: false,
    })),
    pending: {
      action: "cancel",
      restartRequested: false,
      changes: [{ category: "keys", target: "C:/new/keys", migrate: true }],
    },
    recordedCopies: [],
    hasError: true,
  },
  action: "retry",
});
const request = () => ({
  requestId: "recovery-review",
  pluginId: "recovery-tool",
  method: "storage.recovery.request",
  params: params(),
});
const settle = async () => {
  for (let n = 0; n < 12; n++) await Promise.resolve();
};
let cleanup: (() => void) | undefined;
beforeEach(() => {
  vi.useFakeTimers();
  mocks.invoke.mockReset().mockResolvedValue(undefined);
  useDialogs.getState().close();
  usePlugins.setState({ items: [{ id: "recovery-tool", name: "Recovery tool" } as PluginInfo] });
});
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
  useDialogs.getState().close();
  vi.useRealTimers();
});
it.each(["en-US", "zh-CN"])(
  "shows persisted cancellation on retry and native restart boundaries in %s",
  async (language) => {
    await i18n.changeLanguage(language);
    const body = storageRecoveryReview(params());
    expect(body).toContain(i18n.t("storage.recovery.reviewCancel"));
    expect(body).toContain("C:/old/keys");
    expect(body).toContain("C:/new/keys");
    expect(body).toContain(i18n.t("storage.recovery.reviewBoundaries"));
  },
);
it("requires live native authorization and plugin-identified approval", async () => {
  const pending = runPluginWorkspaceRequest(request());
  await settle();
  const dialog = useDialogs.getState().dialog;
  expect(dialog.kind).toBe("confirm");
  if (dialog.kind !== "confirm") throw Error("missing review");
  expect(dialog.title).toContain("Recovery tool");
  dialog.onConfirm();
  await expect(pending).resolves.toBe(true);
  useDialogs.getState().close();
  mocks.invoke.mockRejectedValueOnce(Error("revoked"));
  await expect(runPluginWorkspaceRequest(request())).rejects.toThrow("revoked");
  expect(useDialogs.getState().dialog.kind).toBe("none");
});
it("closes cancelled native reviews and expires unapproved requests", async () => {
  cleanup = await wirePluginWorkspaceBridge();
  const cancelled = runPluginWorkspaceRequest(request());
  await settle();
  mocks.handlers.get("plugin://workspace-cancelled")?.({
    payload: { requestId: "recovery-review" },
  });
  await expect(cancelled).resolves.toBe(false);
  expect(useDialogs.getState().dialog.kind).toBe("none");
  const timed = runPluginWorkspaceRequest(request());
  await settle();
  await vi.advanceTimersByTimeAsync(55000);
  await expect(timed).resolves.toBe(false);
});
it("preserves unrelated dialogs and rejects incomplete native metadata", async () => {
  useDialogs.getState().openGroup();
  await expect(runPluginWorkspaceRequest(request())).rejects.toThrow("dialog.busy");
  expect(useDialogs.getState().dialog.kind).toBe("group");
  expect(() => storageRecoveryReview({ snapshot: { version: 1 }, action: "retry" })).toThrow(
    "storage.recovery.invalidState",
  );
});
