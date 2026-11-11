import { describe, expect, it, vi } from "vitest";
import { createFileBrowserContext } from "@/lib/extensions/files/context";
import type { FrontendFileBrowserSnapshot } from "@/lib/extensions/uiSdkContract";

function fixture(count = 600) {
  const entries = Array.from({ length: count }, (_, i) => ({
    name: `file-${i}`,
    path: `/work/${i}`,
    isDir: i === 0,
    isHidden: false,
    size: i,
    modified: null,
    permissions: null,
    internalSecret: "never projected",
  }));
  const actions = { navigate: vi.fn(), refresh: vi.fn(), select: vi.fn(), open: vi.fn() };
  const snapshot: FrontendFileBrowserSnapshot = {
    paneId: "pane",
    revision: "r1",
    source: { kind: "local" },
    path: "/work",
    total: count,
    selectedPaths: [],
    busy: false,
    error: null,
  };
  let live = true;
  const create = () =>
    createFileBrowserContext(
      snapshot,
      entries,
      () => {
        if (!live) throw new Error("changed");
      },
      actions,
    );
  return {
    entries,
    actions,
    snapshot,
    create,
    retire: () => {
      live = false;
    },
  };
}

describe("file browser public context", () => {
  it("pages an immutable revision and projects only public fields", () => {
    const f = fixture();
    const context = f.create();
    const first = context.read({ revision: "r1" });
    expect(first.items).toHaveLength(256);
    expect(first.nextOffset).toBe(256);
    expect(first.items[0]).not.toHaveProperty("internalSecret");
    expect(context.read({ revision: "r1", offset: 512 })).toMatchObject({
      nextOffset: null,
      total: 600,
    });
    expect(context.read({ revision: "r1", offset: 600 }).items).toEqual([]);
    expect(() => context.read({ revision: "old" })).toThrow("changed");
    for (const offset of [-1, 0.5, NaN, Infinity, 601])
      expect(() => context.read({ revision: "r1", offset })).toThrow("invalid");
    f.entries[0]!.name = "mutated";
    f.entries.pop();
    expect(context.read({ revision: "r1" }).total).toBe(600);
    expect(first.items[0]!.name).toBe("file-0");
    expect(context.read({ revision: "r1" }).items[0]!.name).toBe("file-0");
    expect(Object.isFrozen(first.items[0])).toBe(true);
    expect(Object.isFrozen(context.snapshot.selectedPaths)).toBe(true);
  });
  it("uses the existing host actions and rejects foreign entries atomically", () => {
    const f = fixture(4);
    const c = f.create();
    c.select(["/work/1", "/work/2"]);
    expect(f.actions.select).toHaveBeenCalledWith(["/work/1", "/work/2"]);
    for (const paths of [["/private"], ["/work/1", "/work/1"]])
      expect(() => c.select(paths)).toThrow("invalid");
    expect(f.actions.select).toHaveBeenCalledOnce();
    c.open("/work/0");
    expect(f.actions.navigate).toHaveBeenCalledWith("/work/0");
    c.open("/work/1", "preview");
    expect(f.actions.open).toHaveBeenCalledWith(expect.objectContaining({ path: "/work/1" }), true);
    expect(() => c.open("/private")).toThrow("invalid");
    expect(() => c.open("/work/0", "preview")).toThrow("invalid");
    c.refresh();
    expect(f.actions.refresh).toHaveBeenCalledOnce();
    for (const path of ["", " ", "bad\0path", "bad\npath", "x".repeat(32769)])
      expect(() => c.navigate(path)).toThrow("invalid");
  });
  it("keeps old snapshots readable but blocks all actions after retirement or while busy", () => {
    const f = fixture(3);
    const c = f.create();
    f.retire();
    expect(c.read({ revision: "r1" }).items).toHaveLength(3);
    for (const operation of [
      () => c.navigate("/next"),
      () => c.refresh(),
      () => c.select([]),
      () => c.open("/work/1"),
    ])
      expect(operation).toThrow("changed");
    f.snapshot.busy = true;
    const busy = fixture(3);
    busy.snapshot.busy = true;
    const b = busy.create();
    expect(() => b.refresh()).toThrow("busy");
    expect(() => b.open("/work/1")).toThrow("busy");
    expect(b.read({ revision: "r1" }).items).toHaveLength(3);
  });
});
