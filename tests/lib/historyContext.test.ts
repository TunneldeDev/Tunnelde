import { expect, it, vi } from "vitest";
import { createHistoryContext, type HistoryActions } from "@/lib/extensions/history/context";

function fixture(count = 2, command = "pwd") {
  let current = true;
  const actions: HistoryActions = {
    validate: vi.fn(() => current),
    setQuery: vi.fn(),
    refresh: vi.fn(),
    delete: vi.fn(async () => {}),
    execute: vi.fn(async () => {}),
    requestClear: vi.fn(),
  };
  const rows = Array.from({ length: count }, (_, id) => ({
    id: id + 1,
    command: command + id,
    hostId: "host",
    executedAt: id,
  }));
  const snapshot = {
    sessionId: "session",
    hostId: "host",
    title: "Host",
    query: "",
    revision: "revision",
    total: count,
    busy: false,
    error: null,
  };
  const api = createHistoryContext(
    snapshot,
    rows,
    () => {
      if (!current) throw Error("plugin.history.changed");
    },
    actions,
  );
  return {
    api,
    rows,
    snapshot,
    actions,
    stop: () => {
      current = false;
    },
  };
}

it("projects immutable rows and bounds both entry count and text without dropping commands", () => {
  const { api, rows } = fixture(300);
  rows[0]!.command = "changed internally";
  const page = api.read({ revision: "revision" });
  expect(page.items).toHaveLength(128);
  expect(page.items[0]!.command).toBe("pwd0");
  expect(Object.isFrozen(page.items[0])).toBe(true);
  expect(Object.isFrozen(api.snapshot)).toBe(true);
  const next = api.read({ revision: "revision", offset: page.nextOffset! });
  expect(next.items[0]!.id).toBe(129);
  const long = fixture(40, "x".repeat(3996)).api;
  const first = long.read({ revision: "revision" });
  expect(first.items).toHaveLength(16);
  expect(first.items.reduce((n, row) => n + row.command.length, 0)).toBeLessThanOrEqual(65536);
  expect(long.read({ revision: "revision", offset: first.nextOffset! }).items[0]!.id).toBe(17);
});

it("rejects invalid pages, stale actions and ids outside the visible revision", async () => {
  const { api, stop, actions } = fixture();
  for (const offset of [-1, 0.5, Infinity, NaN, 3])
    expect(() => api.read({ revision: "revision", offset })).toThrow("invalid");
  expect(() => api.read(null!)).toThrow("invalid");
  expect(() => api.read({ revision: "old" })).toThrow("changed");
  expect(() => api.setQuery("x".repeat(4097))).toThrow("invalid");
  expect(() => api.setQuery(null!)).toThrow("invalid");
  await expect(api.delete(999)).rejects.toThrow("invalid");
  await api.execute(1);
  expect(actions.execute).toHaveBeenCalledWith(expect.objectContaining({ command: "pwd0" }));
  const authorize = vi.fn();
  api.requestClear(authorize);
  expect(actions.requestClear).toHaveBeenCalledWith(authorize);
  api.setQuery("@command:pwd");
  api.refresh();
  stop();
  await expect(api.execute(1)).rejects.toThrow("changed");
  await expect(api.delete(1)).rejects.toThrow("changed");
  expect(() => api.requestClear(authorize)).toThrow("changed");
  expect(() => api.refresh()).toThrow("changed");
  // A retained immutable page is safe to read until the outer provider lease is revoked.
  expect(api.read({ revision: "revision" }).items).toHaveLength(2);
});

it("allows retry and filtering but no destructive actions while loading or failed", async () => {
  for (const state of [
    { busy: true, error: null },
    { busy: false, error: "unavailable" },
  ]) {
    const { snapshot, rows, actions } = fixture();
    const api = createHistoryContext({ ...snapshot, ...state }, rows, () => {}, actions);
    api.refresh();
    api.setQuery("pwd");
    await expect(api.execute(1)).rejects.toThrow("busy");
    await expect(api.delete(1)).rejects.toThrow("busy");
    expect(() => api.requestClear(() => {})).toThrow("busy");
  }
});

it("marks legacy oversized commands, always advances pages and refuses unseen command tails", async () => {
  const { api, actions } = fixture(40, "x".repeat(70000));
  const page = api.read({ revision: "revision" });
  expect(page.items).toHaveLength(16);
  expect(page.items.every((row) => row.command.length === 4000 && row.truncated)).toBe(true);
  expect(page.nextOffset).toBe(16);
  await expect(api.execute(1)).rejects.toThrow("invalid");
  expect(actions.execute).not.toHaveBeenCalled();
  await api.delete(1);
  expect(actions.delete).toHaveBeenCalledOnce();
});
