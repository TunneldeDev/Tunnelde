import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import type * as IpcModule from "@/lib/api/ipc";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
  stop: vi.fn(),
  native: vi.fn(),
  toast: vi.fn(),
  request: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));
vi.mock("@/lib/api/ipc", async (original) => ({
  ...(await original<typeof IpcModule>()),
  isTauri: mocks.native,
}));
vi.mock("@/store/toasts", () => ({ toast: mocks.toast }));
vi.mock("@/lib/session/restart", () => ({ requestApplicationAction: mocks.request }));

import { useNativeApplicationActions } from "@/lib/session/useNativeApplicationActions";
import { prepareWindowReload } from "@/lib/session/reload";

beforeEach(() => {
  vi.resetAllMocks();
  mocks.native.mockReturnValue(true);
  mocks.invoke.mockResolvedValue(undefined);
  mocks.listen.mockResolvedValue(mocks.stop);
  mocks.stop.mockResolvedValue(undefined);
});

async function mount() {
  const rendered = renderHook(useNativeApplicationActions);
  await waitFor(() =>
    expect(mocks.invoke).toHaveBeenCalledWith("application_action_claim", {
      owner: expect.any(String),
    }),
  );
  const owner = mocks.invoke.mock.calls.find(([name]) => name === "application_action_claim")![1]
    .owner;
  return { ...rendered, owner };
}

it("claims only after listening and accepts only its own valid native actions", async () => {
  const { owner } = await mount();
  expect(mocks.listen).toHaveBeenCalledWith("ui://application-action", expect.any(Function));
  expect(mocks.listen.mock.invocationCallOrder[0]).toBeLessThan(
    mocks.invoke.mock.invocationCallOrder[0]!,
  );
  const receive = mocks.listen.mock.calls[0]![1];
  await act(async () => {
    receive({ payload: { owner: "stale", id: "old", action: "quit" } });
    receive({ payload: { owner, id: "unknown", action: "shutdown-system" } });
  });
  expect(mocks.request).not.toHaveBeenCalled();
  await act(async () => receive({ payload: { owner, id: "quit-request", action: "quit" } }));
  expect(mocks.request).toHaveBeenCalledWith("quit", expect.any(Function));
  expect(mocks.invoke).not.toHaveBeenCalledWith("application_action_finish", expect.anything());
  await mocks.request.mock.calls[0]![1]();
  expect(mocks.invoke).toHaveBeenCalledWith("application_action_finish", {
    owner,
    id: "quit-request",
  });
});

it("releases native ownership before reload and blocks reload when release fails", async () => {
  const rendered = await mount();
  mocks.invoke.mockImplementation((name) =>
    name === "application_action_release"
      ? Promise.reject(Error("release failed"))
      : Promise.resolve(),
  );
  await expect(prepareWindowReload()).rejects.toThrow("release failed");
  expect(mocks.stop).not.toHaveBeenCalled();
  mocks.invoke.mockResolvedValue(undefined);
  await prepareWindowReload();
  expect(mocks.invoke).toHaveBeenCalledWith("application_action_release", {
    owner: rendered.owner,
  });
  expect(mocks.stop).toHaveBeenCalledOnce();
  rendered.unmount();
  expect(mocks.stop).toHaveBeenCalledOnce();
});

it("cleans a claim that completes after unmount and ignores late delivery", async () => {
  let finish!: () => void;
  mocks.invoke.mockImplementation((name) =>
    name === "application_action_claim"
      ? new Promise<void>((resolve) => {
          finish = resolve;
        })
      : Promise.resolve(),
  );
  const rendered = await mount();
  rendered.unmount();
  await act(async () => {
    finish();
  });
  expect(mocks.invoke).toHaveBeenCalledWith("application_action_release", {
    owner: rendered.owner,
  });
  expect(mocks.stop).toHaveBeenCalledOnce();
  await act(async () =>
    mocks.listen.mock.calls[0]![1]({
      payload: { owner: rendered.owner, id: "late", action: "restart" },
    }),
  );
  expect(mocks.request).not.toHaveBeenCalled();
});

it("does not claim outside desktop mode, and cleans a failed claim", async () => {
  mocks.native.mockReturnValue(false);
  const browser = renderHook(useNativeApplicationActions);
  expect(mocks.listen).not.toHaveBeenCalled();
  browser.unmount();
  mocks.native.mockReturnValue(true);
  mocks.invoke.mockRejectedValueOnce(Error("claim failed"));
  renderHook(useNativeApplicationActions);
  await waitFor(() => expect(mocks.stop).toHaveBeenCalledOnce());
  expect(mocks.toast).toHaveBeenCalled();
});
