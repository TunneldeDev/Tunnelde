import { act, renderHook } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import "@/i18n/i18n";
import { createQuickAccessContext } from "@/lib/extensions/search/quickAccess/context";
import { guardQuickAccessProvider } from "@/lib/extensions/search/quickAccess/provider";
import { projectQuickAccess } from "@/lib/extensions/search/quickAccess/projection";
import {
  useQuickAccessController,
  type QuickAccessController,
} from "@/features/quickAccess/runtime/useController";
import { useQuickAccess } from "@/store/quickAccess";
import { usePlugins } from "@/store/plugins";
import { useHosts } from "@/store/hosts";
import { useWorkspace } from "@/store/workspace";
import { useEditors } from "@/store/editors";
import { useSearchRoots } from "@/store/searchRoots";
import { useSsh } from "@/store/ssh";
import { useSettings } from "@/store/settings";
import { DEFAULT_SETTINGS } from "@/lib/prefs/defaults";
import type { SshSession } from "@/lib/api/types";

beforeEach(() => {
  useQuickAccess.getState().show(">");
  usePlugins.setState({ items: [] });
  useHosts.setState({ hosts: [] });
  useWorkspace.setState({ tabs: [], activeId: null });
  useEditors.setState({ entries: {} });
  useSearchRoots.setState({ roots: {} });
  useSsh.setState({ sessions: [] });
  useSettings.setState({ settings: DEFAULT_SETTINGS });
});

it("pages escaped serialized text within the budget and never leaks executable closures", () => {
  const filtered = Array.from({ length: 300 }, (_, index) => ({
    id: `command.${index}`,
    title: '"'.repeat(3000),
    detail: "\\".repeat(4000),
    run: vi.fn(),
  }));
  const manager = {
    filtered,
    frame: { revision: "r" },
    mode: "commands",
    query: ">",
    index: 0,
    error: "",
    searching: false,
    searchKey: "s",
    result: null,
    limited: false,
    validate: () => true,
  } as unknown as QuickAccessController;
  const context = createQuickAccessContext(manager);
  const seen = [];
  let offset = 0;
  do {
    const page = context.read({ revision: "r", offset });
    expect(JSON.stringify(page.items).length).toBeLessThanOrEqual(65536);
    expect(page.items.length).toBeLessThanOrEqual(128);
    expect(page.items.length).toBeGreaterThan(0);
    seen.push(...page.items.map((item) => item.key));
    if (page.nextOffset === null) break;
    expect(page.nextOffset).toBeGreaterThan(offset);
    offset = page.nextOffset;
  } while (offset < 300);
  expect(new Set(seen).size).toBe(300);
  const page = context.read({ revision: "r" });
  expect(Object.isFrozen(page.items[0])).toBe(true);
  expect(page.items[0]).not.toHaveProperty("run");
  expect(page.items[0]!.truncated).toBe(true);
  for (const offset of [-1, 0.5, NaN, Infinity, 301])
    expect(() => context.read({ revision: "r", offset })).toThrow("invalid");
  expect(() => context.read({ revision: "old" })).toThrow("changed");
});

it("classifies built-in host commands separately from host results", () => {
  expect(
    projectQuickAccess(
      ["host.new", "host.connect.h", "file:/a:1", "tab:a"].map((id) => ({
        id,
        title: id,
        run() {},
      })),
    ).map((row) => row.kind),
  ).toEqual(["command", "host", "file", "tab"]);
});

it("retires a frame synchronously on query changes and survives no-op selection", () => {
  const { result } = renderHook(() => useQuickAccessController(">"));
  const context = createQuickAccessContext(result.current);
  act(() => context.setQuery(">"));
  expect(result.current.validate()).toBe(true);
  act(() => {
    context.setQuery(">welcome");
    expect(() => context.invoke({ revision: context.snapshot.revision, key: "result:0" })).toThrow(
      "changed",
    );
  });
  expect(context.read({ revision: context.snapshot.revision }).total).toBeGreaterThan(1);
  expect(result.current.filtered).toHaveLength(1);
  expect(() => context.setQuery(">restart")).toThrow("changed");
});

it("rejects retained operations across close/reopen ABA and live store changes", () => {
  const { result } = renderHook(() => useQuickAccessController(">welcome"));
  const context = createQuickAccessContext(result.current);
  act(() => {
    useQuickAccess.getState().close();
    useQuickAccess.getState().show(">");
  });
  expect(() => context.invoke({ revision: context.snapshot.revision, key: "result:0" })).toThrow(
    "changed",
  );
  const next = renderHook(() => useQuickAccessController(">welcome"));
  const current = createQuickAccessContext(next.result.current);
  act(() => {
    usePlugins.setState({ items: [] });
    expect(() => current.invoke({ revision: current.snapshot.revision, key: "result:0" })).toThrow(
      "changed",
    );
  });
});

it("retires remote results as soon as the connection or selected root disappears", () => {
  useQuickAccess.getState().show("");
  useSsh.setState({ sessions: [{ id: "s" } as SshSession] });
  useSearchRoots.setState({ roots: { files: [{ id: "r", path: "/work", sessionId: "s" }] } });
  const { result } = renderHook(() => useQuickAccessController(""));
  const context = createQuickAccessContext(result.current);
  expect(context.snapshot.root?.sessionId).toBe("s");
  act(() => {
    useSsh.setState({ sessions: [] });
    expect(() => context.setQuery("hello")).toThrow("changed");
  });
  expect(result.current.root).toBeUndefined();
});

it("checks live provider authority on every action and immutable retained read", () => {
  const { result } = renderHook(() => useQuickAccessController(">welcome"));
  let active = true,
    writable = false;
  const context = createQuickAccessContext(result.current);
  const provider = guardQuickAccessProvider(
    { ...context, Entries: () => null },
    () => {
      if (!active) throw Error("revoked");
    },
    () => writable,
  );
  const request = { revision: provider.snapshot.revision, key: "result:0" };
  expect(provider.capabilities.invoke).toBe(false);
  expect(() => provider.invoke(request)).toThrow("permissionDenied");
  writable = true;
  act(() => provider.invoke(request));
  expect(useWorkspace.getState().tabs.some((tab) => tab.kind === "welcome")).toBe(true);
  expect(() => provider.invoke(request)).toThrow("changed");
  active = false;
  expect(() => provider.read({ revision: request.revision })).toThrow("revoked");
});

it("validates bounded query and opaque row identities without invoking anything", () => {
  const { result } = renderHook(() => useQuickAccessController(">welcome"));
  const context = createQuickAccessContext(result.current);
  expect(() => context.setQuery("x".repeat(4097))).toThrow("invalid");
  expect(() =>
    context.invoke({ revision: context.snapshot.revision, key: "page.welcome" }),
  ).toThrow("invalid");
  expect(useQuickAccess.getState().query).toBe(">");
});
