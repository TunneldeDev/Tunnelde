import { afterEach, expect, it, vi } from "vitest";
import { startPanelActions } from "@/app/panelActions";
import type { PanelWindowClient } from "@/lib/panels/windowClient";
import type { PanelActionJob } from "@/lib/panels/windowProtocol";
const mock = vi.hoisted(() => ({
  execute: undefined as unknown as (job: PanelActionJob) => Promise<unknown>,
  rules: vi.fn(),
  groups: vi.fn(),
}));
vi.mock("@/features/forwarding/data/store", () => ({ forwardingStore: { refresh: mock.rules } }));
vi.mock("@/features/forwarding/data/groups", () => ({
  forwardingGroupsStore: { refresh: mock.groups },
}));
vi.mock("@/lib/panels/windowActions", () => ({
  startWindowActions: (_: unknown, execute: typeof mock.execute) => {
    mock.execute = execute;
    return { dispose: vi.fn() };
  },
}));
afterEach(() => vi.clearAllMocks());
it("refreshes the actual singleton native readers, not the satellite's display copy or an arbitrary command", async () => {
  const stop = startPanelActions({ windowId: "main" } as PanelWindowClient, vi.fn());
  try {
    expect(
      await mock.execute({
        id: "job",
        lease: { panelId: "forwarding", windowId: "satellite", generation: 7 },
        request: { kind: "refreshForwarding" },
      }),
    ).toBeNull();
    expect(mock.rules).toHaveBeenCalledOnce();
    expect(mock.groups).toHaveBeenCalledOnce();
  } finally {
    stop();
  }
});
