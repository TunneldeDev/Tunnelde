import { expect, it, vi } from "vitest";
import {
  createForwardingContext,
  type ForwardingActions,
} from "@/lib/extensions/forwarding/context";
import { guardForwardingProvider } from "@/lib/extensions/forwarding/provider";

function fixture(count = 2, name = "rule") {
  let current = true;
  const actions: ForwardingActions = {
    validate: () => current,
    refresh: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    requestAdd: vi.fn(),
    requestEdit: vi.fn(),
    requestRemove: vi.fn(),
    requestDisconnect: vi.fn(),
  };
  const rows = Array.from({ length: count }, (_, id) => ({
    id: String(id),
    hostId: "host",
    name,
    mode: "local" as const,
    bindHost: "127.0.0.1",
    bindPort: 8000 + id,
    targetHost: "localhost",
    targetPort: 80,
    revision: "rule-version",
    active: false,
    runtimeId: null,
  }));
  const snapshot = {
    hostId: "host",
    title: "Host",
    revision: "frame",
    total: count,
    connected: true,
    busy: false,
    editing: false,
    error: null,
  };
  const context = createForwardingContext(snapshot, rows, () => {}, actions);
  const authority = { authorize: vi.fn(), origin: vi.fn() };
  return {
    context,
    actions,
    rows,
    authority,
    snapshot,
    expire: () => {
      current = false;
    },
  };
}

it("projects immutable domain rows and bounds both count and text", () => {
  const { context, rows } = fixture(300);
  rows[0]!.name = "internal mutation";
  const page = context.read({ revision: "frame" });
  expect(page.items).toHaveLength(128);
  expect(page.items[0]!.name).toBe("rule");
  expect(Object.isFrozen(page.items[0])).toBe(true);
  expect(Object.isFrozen(context.snapshot)).toBe(true);
  expect(context.read({ revision: "frame", offset: page.nextOffset! }).items[0]!.id).toBe("128");
  const long = fixture(40, "x".repeat(4000)).context;
  expect(long.read({ revision: "frame" }).items.length).toBeLessThan(17);
  expect(() => fixture(1, "x".repeat(65537)).context.read({ revision: "frame" })).toThrow(
    "invalid",
  );
});

it("rejects malformed pages and stale mutations while retained immutable reads remain available", () => {
  const { context, actions, authority, expire } = fixture();
  for (const offset of [-1, 0.5, Infinity, NaN, 3])
    expect(() => context.read({ revision: "frame", offset })).toThrow("invalid");
  expect(() => context.read(null!)).toThrow("invalid");
  expect(() => context.read({ revision: "other" })).toThrow("changed");
  expect(() => context.start("unknown", authority)).toThrow("invalid");
  expect(() => context.stop("0", authority)).toThrow("changed");
  context.start("0", authority);
  expect(actions.start).toHaveBeenCalledWith(
    [expect.objectContaining({ id: "0", revision: "rule-version" })],
    authority,
  );
  context.requestEdit("0", authority);
  context.requestRemove("0", authority);
  context.requestAdd(authority);
  context.requestDisconnect(authority);
  expire();
  for (const action of [
    () => context.startAll(authority),
    () => context.requestAdd(authority),
    () => context.requestEdit("0", authority),
    () => context.requestRemove("0", authority),
    () => context.requestDisconnect(authority),
    () => context.refresh(),
  ])
    expect(action).toThrow("changed");
  expect(context.read({ revision: "frame" }).items).toHaveLength(2);
});

it("separates read access and delayed write authorization", () => {
  const { context, authority, actions } = fixture();
  let allowed = true;
  authority.authorize.mockImplementation(() => {
    if (!allowed) throw Error("revoked");
  });
  const access = vi.fn();
  const api = guardForwardingProvider({ ...context, Entries: () => null }, access, authority, true);
  api.read({ revision: "frame" });
  expect(access).toHaveBeenCalledWith(false);
  api.requestAdd();
  const continuation = vi.mocked(actions.requestAdd).mock.calls[0]![0];
  allowed = false;
  expect(() => continuation.authorize()).toThrow("revoked");
  for (const action of [
    () => api.start("0"),
    () => api.stop("0"),
    () => api.requestEdit("0"),
    () => api.requestRemove("0"),
    () => api.requestDisconnect(),
    () => api.startAll(),
  ])
    expect(action).toThrow("revoked");
  access.mockImplementation(() => {
    throw Error("expired");
  });
  expect(() => api.read({ revision: "frame" })).toThrow("expired");
});

it("allows retry after an operation error while blocking concurrent edits", () => {
  const { snapshot, rows, actions, authority } = fixture();
  const failed = createForwardingContext(
    { ...snapshot, error: "previous request failed" },
    rows,
    () => {},
    actions,
  );
  failed.start("0", authority);
  expect(actions.start).toHaveBeenCalledOnce();
  for (const state of [{ busy: true }, { editing: true }]) {
    const pending = createForwardingContext({ ...snapshot, ...state }, rows, () => {}, actions);
    expect(() => pending.requestEdit("0", authority)).toThrow("busy");
  }
});
