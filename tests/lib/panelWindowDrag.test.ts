import { afterEach, expect, it, vi } from "vitest";
import { installPanelWindowDrag } from "@/lib/panels/windowDrag";
import type { PanelWindowClient } from "@/lib/panels/windowClient";
import { usePanelWindows } from "@/store/panelWindows";
import { SIDEBAR_MIME } from "@/lib/session/sidebarDock";
import { INTERNAL_DRAG_FINISH } from "@/lib/session/internalDragEvents";
import { endLocalPanelDrag, startLocalPanelDrag } from "@/lib/panels/localPanelDrag";
import { createLocalPanelWorkspace } from "@/lib/panels/localWorkspace";
const lease = { panelId: "tasks", windowId: "main", generation: 7 };
const disposers: (() => void)[] = [];
afterEach(() => {
  disposers.splice(0).forEach((stop) => stop());
  endLocalPanelDrag();
});
const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};
function fixture(targetWindow: string | null = "satellite") {
  usePanelWindows.setState({ snapshot: { windows: [], panels: [lease], transfers: [] } });
  let resolveGrant!: (value: string) => void;
  const grant = new Promise<string>((resolve) => {
    resolveGrant = resolve;
  });
  const control = vi.fn((request) =>
    request.action === "issueDrag" ? grant : Promise.resolve(null),
  );
  const releaseDrag = vi.fn().mockResolvedValue({ lease, targetWindow });
  const move = vi.fn().mockResolvedValue(undefined),
    failure = vi.fn();
  const stop = installPanelWindowDrag(
    { windowId: "main", control, releaseDrag } as unknown as PanelWindowClient,
    failure,
    move,
  );
  disposers.push(stop);
  const data = new Map([[SIDEBAR_MIME, "tasks"]]);
  const transfer = {
    getData: (key: string) => data.get(key) ?? "",
    setData: (key: string, value: string) => data.set(key, value),
  } as unknown as DataTransfer;
  const start = () => {
    const event = new Event("dragstart");
    Object.defineProperty(event, "dataTransfer", { value: transfer });
    document.dispatchEvent(event);
  };
  const finish = (released = true, accepted = false) =>
    document.dispatchEvent(
      new CustomEvent(INTERNAL_DRAG_FINISH, { detail: { transfer, released, accepted } }),
    );
  return {
    control,
    releaseDrag,
    move,
    failure,
    resolveGrant,
    start,
    finish,
    transfer,
    stop,
  };
}
it.each(["satellite", null])(
  "uses only the native release target %s and exact lease for a handoff",
  async (target) => {
    const f = fixture(target);
    f.start();
    f.resolveGrant("native-only-token");
    await flush();
    f.finish();
    await flush();
    expect(f.releaseDrag).toHaveBeenCalledExactlyOnceWith("native-only-token");
    expect(f.move).toHaveBeenCalledExactlyOnceWith("tasks", target ?? undefined, lease);
  },
);
it("leaves a release inside the same native window to the local workspace", async () => {
  const f = fixture("main");
  f.start();
  f.resolveGrant("token");
  await flush();
  f.finish();
  await flush();
  expect(f.move).not.toHaveBeenCalled();
});
it("reports native grant failures without interrupting the local drag", async () => {
  const f = fixture();
  f.control.mockImplementation((request) =>
    request.action === "issueDrag"
      ? Promise.reject<string>(new Error("native grant unavailable"))
      : Promise.resolve(null),
  );
  f.start();
  await flush();
  expect(f.failure).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ message: "native grant unavailable" }),
  );
  f.finish();
  expect(f.releaseDrag).not.toHaveBeenCalled();
});
it("reports renewal failures and retires the stale grant", async () => {
  vi.useFakeTimers();
  try {
    const f = fixture();
    f.start();
    f.resolveGrant("token");
    await flush();
    f.control.mockRejectedValueOnce(new Error("renewal expired"));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.control).toHaveBeenCalledWith({ action: "cancelDrag", token: "token" });
    expect(f.failure).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ message: "renewal expired" }),
    );
    f.finish();
    expect(f.releaseDrag).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});
it("renews a held native grant without replacing its single-use token", async () => {
  vi.useFakeTimers();
  try {
    const f = fixture();
    f.start();
    f.resolveGrant("token");
    await flush();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.control).toHaveBeenCalledWith({ action: "renewDrag", token: "token" });
    f.finish();
    await flush();
    expect(f.releaseDrag).toHaveBeenCalledExactlyOnceWith("token");
    const callsAfterRelease = f.control.mock.calls.length;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(f.control.mock.calls.filter(([request]) => request.action === "renewDrag")).toHaveLength(
      1,
    );
    expect(f.control.mock.calls.length).toBe(callsAfterRelease);
  } finally {
    vi.useRealTimers();
  }
});
it.each([
  [false, false],
  [true, true],
])(
  "cancels native grants on cancellation or accepted local drop (%s, %s)",
  async (released, accepted) => {
    const f = fixture();
    f.start();
    f.resolveGrant("token");
    await flush();
    f.finish(released, accepted);
    await flush();
    expect(f.control).toHaveBeenCalledWith({ action: "cancelDrag", token: "token" });
    expect(f.releaseDrag).not.toHaveBeenCalled();
    expect(f.move).not.toHaveBeenCalled();
  },
);
it("cancels exceptionally fast releases instead of sampling a later cursor after a delayed grant", async () => {
  const f = fixture();
  f.start();
  f.finish();
  f.resolveGrant("late");
  await flush();
  expect(f.control).toHaveBeenCalledWith({ action: "cancelDrag", token: "late" });
  expect(f.releaseDrag).not.toHaveBeenCalled();
  expect(f.move).not.toHaveBeenCalled();
});
it("retires late grants after teardown and never moves after a late hit-test reply", async () => {
  const f = fixture();
  f.start();
  f.stop();
  f.resolveGrant("late");
  await flush();
  expect(f.control).toHaveBeenCalledWith({ action: "cancelDrag", token: "late" });
  const g = fixture();
  let resolve!: (value: unknown) => void;
  g.releaseDrag.mockReturnValue(
    new Promise((r) => {
      resolve = r;
    }),
  );
  g.start();
  g.resolveGrant("token");
  await flush();
  g.finish();
  g.stop();
  resolve({ lease, targetWindow: "satellite" });
  await flush();
  expect(g.move).not.toHaveBeenCalled();
});
it("never guesses outside on a native geometry error and reports the failure", async () => {
  const f = fixture();
  f.releaseDrag.mockRejectedValue(new Error("geometry unavailable"));
  f.start();
  f.resolveGrant("token");
  await flush();
  f.finish();
  await flush();
  expect(f.move).not.toHaveBeenCalled();
  expect(f.failure).toHaveBeenCalledOnce();
});
it("recognizes local-workspace opaque tokens without exposing panel IDs as transferable authority", async () => {
  const f = fixture();
  const workspace = createLocalPanelWorkspace();
  workspace.reconcile(["tasks"]);
  f.transfer.setData(SIDEBAR_MIME, "");
  startLocalPanelDrag(workspace, "tasks", f.transfer);
  f.start();
  expect(f.control).toHaveBeenCalledWith({ action: "issueDrag", lease });
  f.resolveGrant("token");
  await flush();
  f.finish();
  await flush();
  expect(f.move).toHaveBeenCalledOnce();
});
it("does not opt an unsupported panel into native movement", () => {
  const f = fixture();
  f.transfer.setData(SIDEBAR_MIME, "settings");
  f.start();
  f.finish();
  expect(f.control).not.toHaveBeenCalled();
  expect(f.releaseDrag).not.toHaveBeenCalled();
});
