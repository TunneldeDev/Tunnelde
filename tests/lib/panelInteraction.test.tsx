import { act, renderHook } from "@testing-library/react";
import { StrictMode, type ReactNode } from "react";
import { expect, it, vi } from "vitest";
import {
  PanelInteractionScope,
  usePanelInteraction,
  usePanelLeaseAction,
} from "@/lib/panels/interaction";
import type { PanelWindowClient } from "@/lib/panels/windowClient";
const lease = { panelId: "knownHosts", windowId: "satellite", generation: 9 };
it("acquires before the caller can open consent, independently releases guards and relays exact-lease actions", async () => {
  let sequence = 0;
  const control = vi.fn(async (r) =>
    r.action === "beginInteraction" ? `guard-${++sequence}` : undefined,
  );
  const action = vi.fn().mockResolvedValue(null);
  const client = { control, action } as unknown as PanelWindowClient;
  const view = renderHook(
    () => ({ acquire: usePanelInteraction(), action: usePanelLeaseAction() }),
    {
      wrapper: ({ children }: { children: ReactNode }) => (
        <StrictMode>
          <PanelInteractionScope value={{ client, lease, staged: false }}>
            {children}
          </PanelInteractionScope>
        </StrictMode>
      ),
    },
  );
  const first = await view.result.current.acquire(),
    second = await view.result.current.acquire();
  await first();
  await first();
  expect(control.mock.calls.filter(([r]) => r.action === "endInteraction")).toEqual([
    [{ action: "endInteraction", lease, id: "guard-1" }],
  ]);
  await view.result.current.action({ kind: "refreshKnownHosts" });
  expect(action).toHaveBeenCalledExactlyOnceWith(lease, { kind: "refreshKnownHosts" });
  view.unmount();
  await second();
  expect(control).toHaveBeenLastCalledWith({ action: "endInteraction", lease, id: "guard-2" });
  expect(control.mock.calls.filter(([r]) => r.action === "endInteraction")).toHaveLength(2);
});
it("releases a guard which resolves after unmount instead of opening a zombie dialog", async () => {
  let resolve!: (id: string) => void;
  const control = vi.fn((r) =>
    r.action === "beginInteraction"
      ? new Promise((r) => {
          resolve = r;
        })
      : Promise.resolve(),
  );
  const client = { control } as unknown as PanelWindowClient;
  const view = renderHook(usePanelInteraction, {
    wrapper: ({ children }) => (
      <PanelInteractionScope value={{ client, lease, staged: false }}>
        {children}
      </PanelInteractionScope>
    ),
  });
  const pending = view.result.current();
  const outcome = expect(pending).rejects.toThrow("disposed");
  view.unmount();
  await act(async () => {
    resolve("late");
    await outcome;
  });
  expect(control).toHaveBeenLastCalledWith({ action: "endInteraction", lease, id: "late" });
});
it("keeps denied or staged consent inert, and never falls back to raw IPC", async () => {
  const control = vi.fn().mockRejectedValue(new Error("frozen"));
  const client = { control } as unknown as PanelWindowClient;
  const wrapper = ({ children }: { children: ReactNode }) => (
    <PanelInteractionScope value={{ client, lease, staged: false }}>
      {children}
    </PanelInteractionScope>
  );
  const view = renderHook(usePanelInteraction, { wrapper });
  await expect(view.result.current()).rejects.toThrow("frozen");
  view.unmount();
  const staged = renderHook(
    () => ({ acquire: usePanelInteraction(), action: usePanelLeaseAction() }),
    {
      wrapper: ({ children }) => (
        <PanelInteractionScope value={{ client, staged: true }}>{children}</PanelInteractionScope>
      ),
    },
  );
  await expect(staged.result.current.acquire()).rejects.toThrow("staleOwner");
  await expect(staged.result.current.action({ kind: "refreshKnownHosts" })).rejects.toThrow(
    "staleOwner",
  );
  expect(control).toHaveBeenCalledTimes(1);
});

it("coalesces release and allows retry after a failed idempotent token release", async () => {
  const control = vi.fn().mockResolvedValue("guard");
  const client = { control } as unknown as PanelWindowClient;
  const view = renderHook(usePanelInteraction, {
    wrapper: ({ children }) => (
      <PanelInteractionScope value={{ client, lease, staged: false }}>
        {children}
      </PanelInteractionScope>
    ),
  });
  const release = await view.result.current();
  control.mockRejectedValueOnce(new Error("transport unavailable"));
  const first = release();
  expect(release()).toBe(first);
  await expect(first).rejects.toThrow("transport unavailable");
  await release();
  view.unmount();
  expect(control.mock.calls.filter(([r]) => r.action === "endInteraction")).toHaveLength(2);
});
