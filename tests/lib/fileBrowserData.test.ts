import { afterEach, expect, it, vi } from "vitest";
import { createFileBrowserContext } from "@/lib/extensions/files/context";
import type { FrontendFileBrowserSnapshot } from "@/lib/extensions/contracts/files/browser";
import { fileBrowserCatalogue, mountFileBrowser } from "@/lib/files/browser/registry";
import { observeFileBrowsers, readFileBrowser } from "@/lib/plugins/files/browser/data";
import { runFileBrowserAction } from "@/lib/plugins/files/browser/actions";
import { runFileBrowserRequest } from "@/app/plugins/fileBrowserRequests";

const registrations: ReturnType<typeof mountFileBrowser>[] = [];
afterEach(() => {
  for (const registration of registrations.splice(0)) registration.dispose();
});

function fixture(paneId = "browser", count = 600) {
  const actions = {
    navigate: vi.fn(),
    refresh: vi.fn(),
    select: vi.fn(),
    open: vi.fn(),
    validate: vi.fn(() => true),
  };
  const entries = Array.from({ length: count }, (_, index) => ({
    path: `/work/${index}`,
    name: `file-${index}`,
    isDir: index === 0,
    isHidden: false,
    size: index,
    modified: null,
    permissions: null,
    privateField: "must not leak",
  }));
  const snapshot: FrontendFileBrowserSnapshot = {
    paneId,
    revision: "r1",
    source: { kind: "local" },
    path: "/work",
    total: count,
    selectedPaths: ["/work/2"],
    busy: false,
    error: null,
  };
  let live = true;
  const registration = mountFileBrowser(paneId);
  registrations.push(registration);
  const publish = (suspended = false) =>
    registration.publish({
      tabId: `tab-${paneId}`,
      suspended,
      browser: createFileBrowserContext(
        snapshot,
        entries,
        () => {
          if (!live) throw new Error("plugin.fileBrowser.changed");
        },
        actions,
      ),
    });
  return {
    actions,
    entries,
    snapshot,
    registration,
    publish,
    retire: () => {
      live = false;
    },
  };
}

it("discovers only committed contexts, detaches metadata and scopes conditional revisions to the query", async () => {
  const first = fixture("first"),
    second = fixture("second");
  expect(await observeFileBrowsers({})).toMatchObject({ changed: true, snapshot: { total: 0 } });
  first.publish();
  second.publish(true);
  const result = await observeFileBrowsers({ limit: 1 });
  if (!result.changed) throw new Error("expected a snapshot");
  expect(result.snapshot).toMatchObject({ total: 2, offset: 0, nextOffset: 1 });
  expect(result.snapshot.items[0]).toMatchObject({
    paneId: "first",
    tabId: "tab-first",
    selectedCount: 1,
    total: 600,
  });
  expect(result.snapshot.items[0]).not.toHaveProperty("selectedPaths");
  expect(result.snapshot.items[0]).not.toHaveProperty("entries");
  expect(await observeFileBrowsers({ limit: 1, revision: result.revision })).toEqual({
    schemaVersion: 1,
    revision: result.revision,
    changed: false,
  });
  expect(
    await observeFileBrowsers({ offset: 1, limit: 1, revision: result.revision }),
  ).toMatchObject({ changed: true, snapshot: { items: [{ paneId: "second", suspended: true }] } });
  first.snapshot.source = { kind: "remote", sessionId: "new-session" };
  first.snapshot.path = "/new";
  first.snapshot.revision = "r2";
  first.publish();
  expect(result.snapshot.items[0]?.source).toEqual({ kind: "local" });
  expect(await observeFileBrowsers({ revision: result.revision, limit: 1 })).toMatchObject({
    changed: true,
    snapshot: { items: [{ paneId: "first", path: "/new" }] },
  });
  expect(() => readFileBrowser({ paneId: "first", revision: "r1" })).toThrow(
    "plugin.fileBrowser.changed",
  );
});

it("reads exact visible order with selection flags, bounded pages and no internal fields", () => {
  const f = fixture();
  f.entries.reverse();
  f.publish();
  const first = readFileBrowser({ paneId: "browser", revision: "r1", limit: 256 });
  expect(first.items).toHaveLength(256);
  expect(first.items[0]?.path).toBe("/work/599");
  expect(first.items[0]).not.toHaveProperty("privateField");
  expect(first.nextOffset).toBe(256);
  const last = readFileBrowser({ paneId: "browser", revision: "r1", offset: 590 });
  expect(last.items.find((entry) => entry.path === "/work/2")?.selected).toBe(true);
  expect(last.nextOffset).toBeNull();
  expect(readFileBrowser({ paneId: "browser", revision: "r1", offset: 600 }).items).toEqual([]);
  expect(() => readFileBrowser({ paneId: "browser", revision: "r1", offset: 601 })).toThrow();
});

it("enforces serialized byte budgets and preserves explicit Unicode error truncation", async () => {
  const f = fixture("long", 200);
  f.entries.forEach((entry, index) => {
    entry.name = "名".repeat(1000);
    entry.path = `/work/${index}${"路".repeat(500)}`;
  });
  f.snapshot.error = "故障🌍".repeat(1000);
  f.publish();
  const result = readFileBrowser({ paneId: "long", revision: "r1", limit: 256 });
  expect(result.items.length).toBeGreaterThan(0);
  expect(result.items.length).toBeLessThan(200);
  expect(result.nextOffset).toBe(result.items.length);
  expect(new TextEncoder().encode(JSON.stringify(result)).length).toBeLessThan(65536);
  const catalogue = await observeFileBrowsers({});
  if (!catalogue.changed) throw new Error("expected snapshot");
  expect(catalogue.snapshot.items[0]?.errorTruncated).toBe(true);
  expect(new TextEncoder().encode(catalogue.snapshot.items[0]!.error!).length).toBeLessThanOrEqual(
    2048,
  );
  expect(catalogue.snapshot.items[0]?.error).not.toMatch(/[\ud800-\udbff]$/u);
});

it("dispatches existing host behavior and refuses hidden, stale, nonvisible and busy actions", () => {
  const f = fixture();
  f.publish();
  const identity = { paneId: "browser", revision: "r1" };
  expect(runFileBrowserAction({ ...identity, action: "refresh" })).toEqual({ accepted: true });
  expect(f.actions.refresh).toHaveBeenCalledOnce();
  runFileBrowserAction({ ...identity, action: "select", paths: ["/work/2"] });
  expect(f.actions.select).toHaveBeenCalledWith(["/work/2"]);
  runFileBrowserAction({ ...identity, action: "open", path: "/work/0" });
  expect(f.actions.navigate).toHaveBeenCalledWith("/work/0");
  runFileBrowserAction({ ...identity, action: "open", path: "/work/1", mode: "preview" });
  expect(f.actions.open).toHaveBeenCalledWith(expect.objectContaining({ path: "/work/1" }), true);
  for (const input of [
    { action: "select", paths: ["/absent"] },
    { action: "select", paths: ["/work/1", "/work/1"] },
    { action: "open", path: "/absent" },
    { action: "open", path: "/work/0", mode: "preview" },
    { action: "refresh", path: "/unused" },
    { action: "open", path: "/work/1", mode: null },
    { action: "delete", path: "/work/1" },
  ])
    expect(() => runFileBrowserAction({ ...identity, ...input })).toThrow();
  f.publish(true);
  expect(() => runFileBrowserAction({ ...identity, action: "refresh" })).toThrow(
    "plugin.fileBrowser.busy",
  );
  f.publish(false);
  f.actions.validate.mockReturnValue(false);
  expect(() => runFileBrowserAction({ ...identity, action: "refresh" })).toThrow(
    "plugin.fileBrowser.changed",
  );
  f.actions.validate.mockReturnValue(true);
  f.retire();
  expect(() => runFileBrowserAction({ ...identity, action: "refresh" })).toThrow(
    "plugin.fileBrowser.changed",
  );
});

it("cleans exact registrations and cannot remove a remounted browser through an old disposer", () => {
  const f = fixture();
  f.publish();
  f.registration.dispose();
  expect(fileBrowserCatalogue().items).toEqual([]);
  expect(() => readFileBrowser({ paneId: "browser", revision: "r1" })).toThrow();
  const replacement = fixture();
  replacement.snapshot.revision = "new";
  replacement.publish();
  f.registration.dispose();
  f.publish();
  expect(readFileBrowser({ paneId: "browser", revision: "new" }).total).toBe(600);
});

it("reauthorizes before mutation and rejects a changed frame while authorization is pending", async () => {
  const f = fixture();
  f.publish();
  let release!: () => void;
  const authorize = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  const pending = runFileBrowserRequest(
    "fileBrowser.action",
    { paneId: "browser", revision: "r1", action: "refresh" },
    authorize,
  );
  f.snapshot.revision = "r2";
  f.publish();
  release();
  await expect(pending).rejects.toThrow("plugin.fileBrowser.changed");
  expect(f.actions.refresh).not.toHaveBeenCalled();
  await expect(
    runFileBrowserRequest(
      "fileBrowser.action",
      { paneId: "browser", revision: "r2", action: "refresh" },
      async () => {
        throw new Error("revoked");
      },
    ),
  ).rejects.toThrow("revoked");
  expect(f.actions.refresh).not.toHaveBeenCalled();
  await expect(
    runFileBrowserRequest("fileBrowser.observe", {}, async () => {
      throw new Error("revoked");
    }),
  ).rejects.toThrow("revoked");
});

it("rejects malformed requests and excessive or unrelated action data", async () => {
  const f = fixture();
  f.publish();
  for (const request of [
    null,
    [],
    { limit: 0 },
    { limit: 33 },
    { offset: -1 },
    { offset: 0.5 },
    { revision: "\n" },
    { revision: "é".repeat(65) },
    { unknown: true },
  ])
    await expect(observeFileBrowsers(request)).rejects.toThrow();
  for (const request of [{ limit: 0 }, { limit: 257 }, { offset: -1 }, { extra: true }])
    expect(() => readFileBrowser({ paneId: "browser", revision: "r1", ...request })).toThrow();
  expect(() =>
    runFileBrowserAction({
      paneId: "browser",
      revision: "r1",
      action: "select",
      paths: Array(257).fill("/work/1"),
    }),
  ).toThrow();
  expect(() =>
    runFileBrowserAction({
      paneId: "browser",
      revision: "r1",
      action: "navigate",
      path: "/bad\0path",
    }),
  ).toThrow();
});

it("bounds large catalogues independently of count and rejects a single unrepresentable row", async () => {
  for (let i = 0; i < 40; i++) {
    const f = fixture(`pane-${i}`, 1);
    f.snapshot.path = "/" + "路".repeat(8000);
    f.snapshot.selectedPaths = ["/filtered-out", "/also-filtered-out"];
    f.publish();
  }
  const first = await observeFileBrowsers({ limit: 32 });
  if (!first.changed) throw new Error("expected metadata");
  expect(first.snapshot.total).toBe(40);
  expect(first.snapshot.items.length).toBeGreaterThan(0);
  expect(first.snapshot.items.length).toBeLessThan(32);
  expect(first.snapshot.nextOffset).toBe(first.snapshot.items.length);
  expect(first.snapshot.items[0]).toMatchObject({ total: 1, selectedCount: 2 });
  expect(new TextEncoder().encode(JSON.stringify(first)).length).toBeLessThanOrEqual(65536);
  const second = await observeFileBrowsers({ offset: first.snapshot.nextOffset!, limit: 32 });
  if (!second.changed) throw new Error("expected metadata");
  expect(second.snapshot.items[0]?.paneId).not.toBe(first.snapshot.items[0]?.paneId);
  for (const registration of registrations.splice(0)) registration.dispose();
  const unrepresentable = fixture("too-long", 1);
  unrepresentable.snapshot.path = "/" + "\t".repeat(32767);
  unrepresentable.publish();
  await expect(observeFileBrowsers({})).rejects.toThrow("plugin.api.responseTooLarge");
});

it("keeps busy panes readable but refuses their actions, malformed values and unknown identities", () => {
  const f = fixture();
  f.snapshot.busy = true;
  f.publish();
  expect(readFileBrowser({ paneId: "browser", revision: "r1" }).total).toBe(600);
  expect(() =>
    runFileBrowserAction({ paneId: "browser", revision: "r1", action: "refresh" }),
  ).toThrow("busy");
  expect(() => readFileBrowser({ paneId: "cloned", revision: "r1" })).toThrow("changed");
  f.snapshot.busy = false;
  for (const value of [NaN, Infinity, -1, Number.MAX_SAFE_INTEGER + 1]) {
    f.entries[0]!.size = value;
    f.publish();
    expect(() => readFileBrowser({ paneId: "browser", revision: "r1" })).toThrow("invalid");
  }
});
