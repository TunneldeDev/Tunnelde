import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { profileActivationReview } from "@/app/plugins/profileActivationRequests";
import { runPluginWorkspaceRequest, wirePluginWorkspaceBridge } from "@/app/pluginWorkspaceBridge";
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
const request = () => ({
  requestId: "profile-review",
  pluginId: "profile-tool",
  method: "profiles.activate",
  params: { name: "Work", groups: ["network", "shortcuts"] },
});
const settle = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};
let cleanup: (() => void) | undefined;
beforeEach(() => {
  vi.useFakeTimers();
  mocks.invoke.mockReset().mockResolvedValue(undefined);
  mocks.handlers.clear();
  useDialogs.getState().close();
  usePlugins.setState({ items: [{ id: "profile-tool", name: "Profile tool" } as PluginInfo] });
});
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
  useDialogs.getState().close();
  vi.useRealTimers();
});

it.each(["en-US", "zh-CN"])(
  "shows trusted profile identity and translated group scope in %s",
  async (language) => {
    await i18n.changeLanguage(language);
    const body = profileActivationReview(request().params);
    expect(body).toContain("Work");
    expect(body).toContain(i18n.t("profiles.groups.network"));
    expect(body).toContain(i18n.t("profiles.groups.shortcuts"));
    expect(body).not.toContain("profiles.groups.");
    expect(profileActivationReview({ name: "Work", groups: [] })).toContain(
      i18n.t("profiles.noPublicChanges"),
    );
  },
);
it.each([
  { name: "Work\nspoof", groups: [] },
  { name: " Work", groups: [] },
  { name: "Work", groups: ["secret"] },
  { name: "Work", groups: ["network", "network"] },
  { name: 4, groups: [] },
])("rejects malformed trusted reviews %#", (params) => {
  expect(() => profileActivationReview(params)).toThrow("profiles.mutation.invalidRequest");
});
it("waits for explicit confirmation and reports user dismissal", async () => {
  const pending = runPluginWorkspaceRequest(request());
  await settle();
  const dialog = useDialogs.getState().dialog;
  expect(dialog.kind).toBe("confirm");
  if (dialog.kind !== "confirm") throw new Error("missing confirmation");
  expect(dialog.title).toContain("Profile tool");
  expect(dialog.body).toContain("Work");
  dialog.onConfirm();
  expect(await pending).toBe(true);
  useDialogs.getState().close();
  const cancelled = runPluginWorkspaceRequest(request());
  await settle();
  useDialogs.getState().close();
  expect(await cancelled).toBe(false);
});
it("native cancellation dismisses only its own pending review", async () => {
  cleanup = await wirePluginWorkspaceBridge();
  await settle();
  mocks.handlers.get("plugin://workspace-request")?.({ payload: request() });
  await settle();
  expect(useDialogs.getState().dialog.kind).toBe("confirm");
  mocks.handlers.get("plugin://workspace-cancelled")?.({
    payload: { requestId: "profile-review" },
  });
  await settle();
  expect(useDialogs.getState().dialog.kind).toBe("none");
});
