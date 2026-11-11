import { beforeEach, afterEach, it, expect, vi } from "vitest";
import { runPluginWorkspaceRequest, wirePluginWorkspaceBridge } from "@/app/pluginWorkspaceBridge";
import { storageLocationReview } from "@/app/plugins/storageLocationRequests";
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
const categories = [
  "database",
  "plugins",
  "pluginData",
  "keys",
  "runtimes",
  "cache",
  "logs",
  "runners",
];
const params = () => ({
  snapshot: {
    version: 1,
    revision: "r",
    locations: categories.map((category) => ({
      category,
      path: `C:/old/${category}`,
      defaultPath: `C:/old/${category}`,
      overridden: false,
    })),
    pending: { changes: [{ category: "keys", target: "C:/new/keys", migrate: true }] },
    recoveryRequired: false,
  },
  changes: [{ category: "keys", target: "C:/new/keys", migrate: true }],
});
const request = (method: string) => ({
  requestId: "storage-review",
  pluginId: "storage-tool",
  method,
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
  usePlugins.setState({ items: [{ id: "storage-tool", name: "Storage tool" } as PluginInfo] });
});
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
  useDialogs.getState().close();
  vi.useRealTimers();
});

it.each(["en-US", "zh-CN"])(
  "renders normalized categories, paths, migration and restart behavior in %s",
  async (language) => {
    await i18n.changeLanguage(language);
    const body = storageLocationReview("storage.locations.schedule", params());
    expect(body).toContain("C:/old/keys");
    expect(body).toContain("→ C:/new/keys");
    expect(body).toContain(i18n.t("storage.categories.keys"));
    expect(body).toContain(i18n.t("storage.locations.reviewSchedule"));
    expect(body).toContain(i18n.t("storage.locations.withData"));
  },
);

it("requires native authorization and explicit plugin-identified approval for both operations", async () => {
  for (const method of ["storage.locations.schedule", "storage.locations.cancel"]) {
    const pending = runPluginWorkspaceRequest(request(method));
    await settle();
    const dialog = useDialogs.getState().dialog;
    expect(dialog.kind).toBe("confirm");
    if (dialog.kind !== "confirm") throw Error("missing dialog");
    expect(dialog.title).toContain("Storage tool");
    expect(dialog.preformatted).toBe(true);
    dialog.onConfirm();
    await expect(pending).resolves.toBe(true);
    useDialogs.getState().close();
  }
  mocks.invoke.mockRejectedValueOnce(new Error("revoked"));
  await expect(runPluginWorkspaceRequest(request("storage.locations.schedule"))).rejects.toThrow(
    "revoked",
  );
  expect(useDialogs.getState().dialog.kind).toBe("none");
});

it("preserves unrelated dialogs and closes its review when its native request is cancelled", async () => {
  useDialogs.getState().openGroup();
  await expect(runPluginWorkspaceRequest(request("storage.locations.schedule"))).rejects.toThrow(
    "dialog.busy",
  );
  expect(useDialogs.getState().dialog.kind).toBe("group");
  useDialogs.getState().close();
  cleanup = await wirePluginWorkspaceBridge();
  const pending = runPluginWorkspaceRequest(request("storage.locations.schedule"));
  await settle();
  mocks.handlers.get("plugin://workspace-cancelled")?.({
    payload: { requestId: "storage-review" },
  });
  await expect(pending).resolves.toBe(false);
  expect(useDialogs.getState().dialog.kind).toBe("none");
});

it("times out without approval and rejects incomplete native review metadata", async () => {
  const pending = runPluginWorkspaceRequest(request("storage.locations.cancel"));
  await settle();
  await vi.advanceTimersByTimeAsync(55000);
  await expect(pending).resolves.toBe(false);
  expect(() =>
    storageLocationReview("storage.locations.schedule", { snapshot: { version: 1 }, changes: [] }),
  ).toThrow("storage.locations.invalidState");
});
