import { expect, it, vi } from "vitest";
import { createResourceScope } from "@/lib/extensions/resourceScope";
import {
  openScopedFrontendView,
  type FrontendViewTransport,
} from "@/lib/extensions/runtime/views/frontend";
import type { FrontendViewContext } from "@/lib/extensions/uiSdk";

const owner = {
  pluginId: "custom",
  generation: 7,
  runtimeId: "boot:7",
  entry: "index.mjs",
  sdkVersion: "0.1.0",
};
function fixture() {
  let context!: FrontendViewContext;
  let draft: unknown;
  const activate = vi.fn(),
    dispose = vi.fn();
  const transport: FrontendViewTransport = {
    load: vi.fn(async () => ({
      activate,
      createView: (value: FrontendViewContext) => {
        context = value;
        return {
          component: () => null,
          captureState: () => draft,
          restoreState: (state: unknown) => {
            draft = state;
          },
          dispose,
        };
      },
    })),
    call: vi.fn(async () => null as never),
    close: vi.fn(async () => {}),
  };
  const parent = createResourceScope();
  const openView = vi.fn(async () => ({ ...owner, token: "native-child" }));
  const open = (state?: { value: unknown }) =>
    openScopedFrontendView({
      owner,
      viewId: "main",
      parent,
      transport,
      openView,
      check: () => {},
      state,
    });
  return { parent, transport, activate, dispose, openView, open, context: () => context };
}
it("opens and restores a scoped child using metadata only, without any activation credential or engine", async () => {
  const f = fixture();
  const view = await f.open({ value: { query: "private draft" } });
  expect(f.openView).toHaveBeenCalledWith();
  expect(f.activate).not.toHaveBeenCalled();
  expect(f.context()).not.toHaveProperty("views");
  expect(f.context()).not.toHaveProperty("backgroundTasks");
  expect(f.context()).not.toHaveProperty("commands");
  expect(await view.captureState()).toEqual({ query: "private draft" });
  await f.context().api.call("api.describe", {});
  expect(f.transport.call).toHaveBeenCalledWith(
    "native-child",
    "api.describe",
    {},
    expect.any(AbortSignal),
  );
  view.dispose();
  f.parent.dispose();
  await vi.waitFor(() => expect(f.transport.close).toHaveBeenCalledWith("native-child"));
  expect(f.dispose).toHaveBeenCalledOnce();
});
it.each([
  { pluginId: "foreign" },
  { generation: 8 },
  { runtimeId: "boot:8" },
  { entry: "other.mjs" },
  { sdkVersion: "9.0.0" },
  { token: "" },
])("rejects mismatched child identity before evaluating its module: %j", async (change) => {
  const f = fixture();
  f.openView.mockResolvedValue({ ...owner, token: "native-child", ...change });
  await expect(f.open()).rejects.toThrow("closed");
  expect(f.transport.load).not.toHaveBeenCalled();
  await vi.waitFor(() => expect(f.transport.close).toHaveBeenCalledOnce());
  f.parent.dispose();
});
it("rejects invalid state before opening a scoped transport and cleans a late aborted child", async () => {
  const f = fixture();
  await expect(f.open({ value: new Date() })).rejects.toThrow("panel.viewState");
  expect(f.openView).not.toHaveBeenCalled();
  let resolve!: (value: Awaited<ReturnType<typeof f.openView>>) => void;
  f.openView.mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const waiting = expect(f.open()).rejects.toThrow("closed");
  f.parent.dispose();
  resolve({ ...owner, token: "late-child" });
  await waiting;
  await vi.waitFor(() => expect(f.transport.close).toHaveBeenCalledWith("late-child"));
  expect(f.transport.load).not.toHaveBeenCalled();
});
