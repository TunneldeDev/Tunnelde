import { describe, expect, it, vi } from "vitest";
import type { RemoteProcess } from "@/lib/api/types";
import { createProcessesContext } from "@/lib/extensions/monitor/processes/context";
import { guardProcessesProvider } from "@/lib/extensions/monitor/processes/provider";
import { queryProcesses } from "@/features/monitor/processes/data/query";

const process = (extra: Partial<RemoteProcess> = {}): RemoteProcess => ({
  pid: 42,
  name: "worker",
  startedAtTicks: 123,
  cpu: 320,
  cpuTotal: 40,
  memory: 0,
  rss: 10,
  ...extra,
});
function fixture(items = [process()]) {
  const actions = {
    validate: vi.fn(() => true),
    setQuery: vi.fn(),
    setSort: vi.fn(),
    select: vi.fn(),
    refresh: vi.fn(),
    setPaused: vi.fn(),
    requestTerminate: vi.fn(),
  };
  const context = createProcessesContext(
    {
      sessionId: "s",
      hostId: "h",
      title: "Host",
      revision: "r",
      query: "",
      sort: { key: "cpuTotal", descending: true },
      busy: false,
      stopping: false,
      paused: false,
      updatedAt: 1,
      error: null,
    },
    items,
    undefined,
    actions,
  );
  return { context, actions };
}
describe("process UI boundaries", () => {
  it("copies explicit DTOs and bounds rows including JSON escaping", () => {
    const source = Array.from({ length: 350 }, (_, i) =>
      process({
        pid: i + 2,
        name: "\u0000".repeat(2000),
        userName: "x".repeat(500),
        gpuPercent: NaN,
        networkRxRate: -1,
      }),
    );
    const { context } = fixture(source);
    source[0]!.name = "mutated";
    let offset: number | null = 0,
      count = 0;
    while (offset !== null) {
      const page = context.read({ revision: "r", offset });
      expect(page.items.length).toBeLessThanOrEqual(128);
      expect(JSON.stringify(page.items).length).toBeLessThanOrEqual(65536);
      expect(Object.isFrozen(page.items[0])).toBe(true);
      const first = page.items[0]!;
      expect(first.name).toHaveLength(512);
      expect(first.truncated).toBe(true);
      expect(first.gpuPercent).toBeNull();
      expect(first.networkRxRate).toBeNull();
      expect(first).not.toHaveProperty("startedAtTicks");
      expect(first).not.toHaveProperty("memory");
      count += page.items.length;
      offset = page.nextOffset;
    }
    expect(count).toBe(350);
  });
  it("validates revision, request types and current ownership", () => {
    const { context, actions } = fixture();
    expect(() => context.read({ revision: "old" })).toThrow("changed");
    for (const offset of [-1, 2, NaN, 0.5])
      expect(() => context.read({ revision: "r", offset })).toThrow("invalid");
    expect(() => context.setQuery("x".repeat(4097))).toThrow("invalid");
    expect(() => context.setSort({ key: "name", descending: "yes" as unknown as boolean })).toThrow(
      "invalid",
    );
    expect(() => context.select({ revision: "old", key: null })).toThrow("changed");
    expect(() => context.requestTerminate({ revision: "r", key: "forged" }, () => {})).toThrow(
      "invalid",
    );
    actions.validate.mockReturnValue(false);
    expect(() => context.refresh()).toThrow("changed");
    expect(() => context.setPaused(false)).toThrow("changed");
    // Retained immutable reads remain possible until the provider lease is revoked.
    expect(context.read({ revision: "r" }).items).toHaveLength(1);
  });
  it("read permission cannot terminate and delayed authorization is checked again", () => {
    const { context, actions } = fixture();
    let writable = false,
      live = true;
    const check = () => {
      if (!live) throw Error("viewUnavailable");
    };
    const guarded = guardProcessesProvider(
      { ...context, Entries: () => null },
      check,
      () => writable,
    );
    expect(guarded.capabilities.terminate).toBe(false);
    expect(() => guarded.requestTerminate({ revision: "r", key: "process:0" })).toThrow(
      "permissionDenied",
    );
    writable = true;
    guarded.requestTerminate({ revision: "r", key: "process:0" });
    expect(actions.requestTerminate).toHaveBeenCalledOnce();
    const authorize = actions.requestTerminate.mock.calls[0]![1] as () => void;
    writable = false;
    expect(authorize).toThrow("permissionDenied");
    live = false;
    expect(() => guarded.read({ revision: "r" })).toThrow("viewUnavailable");
    expect(authorize).toThrow("viewUnavailable");
  });
  it("requires @ for filters, sorts invalid metrics last and preserves multi-core CPU values", () => {
    const items = [
      process(),
      process({ pid: 43, name: "unknown", cpuTotal: NaN }),
      process({ pid: 44, name: "negative", cpuTotal: -1 }),
    ];
    expect(queryProcesses(items, "cpu:>10", { key: "cpuTotal", descending: true })).toEqual([]);
    expect(queryProcesses(items, "@cpu:>10", { key: "cpuTotal", descending: true })).toEqual([
      items[0],
    ]);
    for (const descending of [true, false])
      expect(queryProcesses(items, "", { key: "cpuTotal", descending })[0]!.name).toBe("worker");
    expect(fixture().context.read({ revision: "r" }).items[0]!.cpuPerCore).toBe(320);
  });
});
