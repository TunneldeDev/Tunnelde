import { webcrypto } from "node:crypto";
import { afterAll, beforeEach, expect, it, vi } from "vitest";
import { runPluginWorkspaceRequest } from "@/app/pluginWorkspaceBridge";
import { editorDocument, undoEditorEdit, useEditors } from "@/store/editors";
import { useWorkspace } from "@/store/workspace";
import type { EditorBufferIdentity } from "@/lib/extensions/contracts/editor/data/identity";
import type { EditorBufferObservation } from "@/lib/extensions/contracts/editor/data/observation";
import type { EditorBufferRange } from "@/lib/extensions/contracts/editor/data/range";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), write: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@/lib/api/ipc", () => ({
  api: { localWriteText: mocks.write, sftpWriteText: mocks.write },
}));

const tabId = "buffer-tab",
  documentId = "buffer-lifetime";
const identity = (): EditorBufferIdentity => {
  const document = editorDocument(tabId)!;
  return { tabId, documentId: document.documentId, version: document.version };
};
const call = (method: string, params: unknown = {}, signal?: AbortSignal) =>
  runPluginWorkspaceRequest(
    {
      requestId: "buffer-request",
      pluginId: "buffer-plugin",
      method,
      params: params as Record<string, unknown>,
    },
    signal,
  );
const observe = (params: unknown = {}, signal?: AbortSignal) =>
  call("editor.observe", params, signal) as Promise<EditorBufferObservation>;
const range = (params: Record<string, unknown> = {}) =>
  call("editor.readRange", { ...identity(), offset: 0, ...params }) as Promise<EditorBufferRange>;
const edits = (values: unknown, params: Record<string, unknown> = {}) =>
  call("editor.applyEdits", { ...identity(), edits: values, ...params });

function prepare(content = "A😀中文\nZ") {
  useEditors.getState().discard(tabId);
  useEditors.setState({
    entries: {
      [tabId]: {
        tabId,
        documentId,
        version: 0,
        sessionId: "private-session",
        path: "/workspace/a.txt",
        name: "a.txt",
        content,
        baseline: content,
        loading: false,
        saving: false,
        error: null,
      },
    },
  });
  useWorkspace.setState({
    activeId: tabId,
    tabs: [{ id: tabId, kind: "editor", title: "a.txt", hostId: null, pinned: false }],
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.stubGlobal("crypto", webcrypto);
  mocks.invoke.mockReset().mockResolvedValue(undefined);
  mocks.write.mockReset();
  prepare();
});
afterAll(() => vi.unstubAllGlobals());

it("observes detached metadata without content, private state or disk IO", async () => {
  const result = await observe();
  expect(result).toEqual({
    schemaVersion: 1,
    revision: expect.stringMatching(/^[0-9a-f]{64}$/),
    changed: true,
    snapshot: {
      ...identity(),
      path: "/workspace/a.txt",
      name: "a.txt",
      utf16Length: 7,
      dirty: false,
    },
  });
  expect(await observe({ revision: result.revision })).toEqual({
    schemaVersion: 1,
    revision: result.revision,
    changed: false,
  });
  if (result.changed && result.snapshot) Object.assign(result.snapshot, { name: "mutated" });
  expect(editorDocument(tabId)!.name).toBe("a.txt");
  expect(mocks.invoke.mock.calls.every(([name]) => name === "plugin_workspace_authorize")).toBe(
    true,
  );
  expect(mocks.write).not.toHaveBeenCalled();
});

it("changes revision for dirty-only saves, document lifetimes, length and selection", async () => {
  useEditors.getState().change(tabId, "edited");
  const dirty = await observe();
  const entry = useEditors.getState().entries[tabId]!;
  useEditors.setState({ entries: { [tabId]: { ...entry, baseline: entry.content } } });
  const saved = await observe({ revision: dirty.revision });
  expect(saved.changed && saved.snapshot).toMatchObject({ version: entry.version, dirty: false });
  expect(saved.revision).not.toBe(dirty.revision);
  const specified = await observe({ tabId });
  useWorkspace.setState({ activeId: "settings" });
  expect(await observe({ tabId, revision: specified.revision })).toMatchObject({ changed: false });
  expect(await observe({ revision: saved.revision })).toMatchObject({
    changed: true,
    snapshot: null,
  });
  useEditors.setState({
    entries: { [tabId]: { ...entry, documentId: "reopened", content: "longer text" } },
  });
  expect(await observe({ tabId, revision: specified.revision })).toMatchObject({
    changed: true,
    snapshot: { documentId: "reopened", utf16Length: 11 },
  });
});

it("returns unavailable metadata for closed, loading, errored and disconnected buffers", async () => {
  for (const state of [{ loading: true }, { error: "failure" }, { disconnected: true }]) {
    prepare();
    useEditors.setState({
      entries: { [tabId]: { ...useEditors.getState().entries[tabId]!, ...state } },
    });
    expect(await observe()).toMatchObject({ changed: true, snapshot: null });
  }
  useEditors.getState().discard(tabId);
  expect(await observe({ tabId })).toMatchObject({ snapshot: null });
});

it("rejects retained editor state after its workspace tab closes or changes kind", async () => {
  for (const kind of ["closed", "settings", "hidden"]) {
    prepare();
    const previous = identity();
    if (kind === "closed") useWorkspace.getState().close(tabId);
    else
      useWorkspace.setState({
        tabs: [
          {
            id: tabId,
            kind: kind === "settings" ? "settings" : "editor",
            title: "changed",
            hostId: null,
            pinned: false,
            hidden: kind === "hidden",
          },
        ],
      });
    expect(editorDocument(tabId)).not.toBeNull();
    expect(await observe({ tabId })).toMatchObject({ changed: true, snapshot: null });
    await expect(range({ ...previous })).rejects.toThrow("editor.documentChanged");
    await expect(edits([], { ...previous })).rejects.toThrow("editor.documentChanged");
    expect(editorDocument(tabId)!.version).toBe(0);
  }
});

it("reads a large buffer in bounded scalar-aligned pages and reaches EOF", async () => {
  const text = "中😀".repeat(45000);
  prepare(text);
  await expect(call("editor.active")).rejects.toThrow("editor.documentTooLarge");
  let offset = 0,
    collected = "";
  do {
    const page = await range({ offset });
    expect(page).toMatchObject({
      schemaVersion: 1,
      ...identity(),
      offset,
      totalLength: text.length,
    });
    expect(page.text.length).toBeLessThanOrEqual(16384);
    expect(page.text).not.toMatch(/[\ud800-\udbff]$/u);
    collected += page.text;
    if (page.nextOffset === null) break;
    expect(page.nextOffset).toBeGreaterThan(offset);
    offset = page.nextOffset;
  } while (offset < text.length);
  expect(collected).toBe(text);
  expect(await range({ offset: text.length })).toMatchObject({ text: "", nextOffset: null });
  expect(await range({ offset: 0, limit: 2 })).toMatchObject({ text: "中", nextOffset: 1 });
});

it("rejects invalid page bounds and never bisects a surrogate pair", async () => {
  for (const offset of [-1, 0.5, 2, 9, null, "0", Number.MAX_SAFE_INTEGER + 1])
    await expect(range({ offset })).rejects.toThrow("invalid:offset");
  for (const limit of [null, 1, 16385, 2.5, "2"])
    await expect(range({ limit })).rejects.toThrow("invalid:limit");
  expect(await range({ offset: 1, limit: 2 })).toMatchObject({ text: "😀", nextOffset: 3 });
});

it("uses exact identity/version for read and write across edits, disconnects and reopening", async () => {
  const previous = identity();
  useEditors.getState().change(tabId, "changed");
  await expect(range({ ...previous })).rejects.toThrow("editor.documentChanged");
  await expect(edits([], { ...previous })).rejects.toThrow("editor.documentChanged");
  prepare();
  for (const state of [
    { disconnected: true },
    { loading: true },
    { error: "bad" },
    { documentId: "new" },
  ]) {
    useEditors.setState({
      entries: { [tabId]: { ...useEditors.getState().entries[tabId]!, ...state } },
    });
    await expect(call("editor.readRange", { ...previous, offset: 0 })).rejects.toThrow(
      "editor.documentChanged",
    );
    await expect(call("editor.applyEdits", { ...previous, edits: [] })).rejects.toThrow(
      "editor.documentChanged",
    );
    prepare();
  }
  useEditors.getState().discard(tabId);
  await expect(call("editor.readRange", { ...previous, offset: 0 })).rejects.toThrow(
    "editor.documentChanged",
  );
});

it("commits a batch against original offsets once and restores it with one undo", async () => {
  const original = editorDocument(tabId)!;
  expect(
    await edits([
      { start: 0, end: 1, text: "B" },
      { start: 3, end: 5, text: "hello" },
      { start: 7, end: 7, text: "!" },
    ]),
  ).toEqual({ schemaVersion: 1, ...identity(), version: 1, dirty: true, utf16Length: 11 });
  expect(editorDocument(tabId)!.content).toBe("B😀hello\nZ!");
  expect(undoEditorEdit(tabId)).toBe(true);
  expect(editorDocument(tabId)!.content).toBe(original.content);
  expect(undoEditorEdit(tabId)).toBe(false);
  expect(undoEditorEdit(tabId, true)).toBe(true);
  expect(editorDocument(tabId)!.content).toBe("B😀hello\nZ!");
  expect(mocks.write).not.toHaveBeenCalled();
});

it("refuses malformed existing text on new data APIs and permits an explicit repair", async () => {
  prepare("bad\ud800text");
  await expect(range()).rejects.toThrow("editor.invalidUnicode");
  await expect(edits([])).rejects.toThrow("editor.invalidUnicode");
  expect(undoEditorEdit(tabId)).toBe(false);
  await edits([{ start: 3, end: 4, text: "😀" }]);
  expect((await range()).text).toBe("bad😀text");
});

it("keeps empty and same-text batches as no-ops without undo history", async () => {
  for (const values of [[], [{ start: 0, end: 1, text: "A" }], [{ start: 1, end: 1, text: "" }]])
    expect(await edits(values)).toMatchObject({ version: 0, dirty: false });
  expect(undoEditorEdit(tabId)).toBe(false);
});

it("validates every edit atomically, including order, overlaps, Unicode and extra fields", async () => {
  const before = editorDocument(tabId)!;
  const bad = [
    [
      { start: 3, end: 4, text: "x" },
      { start: 0, end: 1, text: "y" },
    ],
    [
      { start: 0, end: 3, text: "x" },
      { start: 1, end: 3, text: "y" },
    ],
    [
      { start: 0, end: 0, text: "x" },
      { start: 0, end: 1, text: "y" },
    ],
    [{ start: 2, end: 3, text: "x" }],
    [{ start: 0, end: 2, text: "x" }],
    [{ start: 0, end: 9, text: "x" }],
    [{ start: 3, end: 1, text: "x" }],
    [
      { start: 0, end: 1, text: "x" },
      { start: 3, end: 4, text: "\ud800" },
    ],
    [{ start: 0, end: 1, text: "\udc00" }],
    [{ start: 0, end: 1, text: 123 }],
    [{ start: 0, end: 1, text: "x", unexpected: true }],
    [null],
    Array.from({ length: 129 }, () => ({ start: 0, end: 0, text: "" })),
    null,
  ];
  for (const values of bad) {
    await expect(edits(values)).rejects.toThrow();
    expect(editorDocument(tabId)).toEqual(before);
    expect(undoEditorEdit(tabId)).toBe(false);
  }
});

it("bounds aggregate replacement bytes, final document bytes and version overflow", async () => {
  const maximum = "中".repeat(21845) + "!";
  await expect(
    edits([
      { start: 0, end: 1, text: maximum },
      { start: 3, end: 3, text: "!" },
    ]),
  ).rejects.toThrow("editor.editTooLarge");
  await edits([{ start: 0, end: 1, text: maximum }]);
  prepare("a".repeat(2 * 1024 * 1024));
  await expect(edits([{ start: 0, end: 0, text: "中" }])).rejects.toThrow(
    "editor.documentTooLarge",
  );
  await edits([{ start: 0, end: 1, text: "b" }]);
  prepare();
  useEditors.setState({
    entries: {
      [tabId]: { ...useEditors.getState().entries[tabId]!, version: Number.MAX_SAFE_INTEGER },
    },
  });
  expect(await edits([])).toMatchObject({ version: Number.MAX_SAFE_INTEGER });
  await expect(edits([{ start: 0, end: 1, text: "b" }])).rejects.toThrow("editor.versionExhausted");
  expect(undoEditorEdit(tabId)).toBe(false);
});

it("rejects unknown/null observation fields and invalid references without store mutation", async () => {
  for (const params of [
    null,
    [],
    { future: true },
    { revision: null },
    { revision: "" },
    { revision: "x".repeat(129) },
    { revision: "\u0085" },
    { tabId: null },
    { tabId: "" },
  ])
    await expect(observe(params)).rejects.toThrow("invalid:");
  for (const params of [
    { version: null },
    { version: -1 },
    { version: 1.5 },
    { tabId: "" },
    { documentId: null },
    { future: true },
    { limit: undefined },
  ])
    await expect(range(params)).rejects.toThrow("invalid:");
  await expect(edits([], { future: true })).rejects.toThrow("invalid:params");
  expect(editorDocument(tabId)!.version).toBe(0);
});

it("fences revoked and cancelled reads and writes before accessing buffers", async () => {
  mocks.invoke.mockRejectedValue(new Error("pluginSecurity.permissionDenied"));
  for (const [method, params] of [
    ["editor.observe", {}],
    ["editor.readRange", { ...identity(), offset: 0 }],
    ["editor.applyEdits", { ...identity(), edits: [] }],
  ] as const)
    await expect(call(method, params)).rejects.toThrow("pluginSecurity.permissionDenied");
  mocks.invoke.mockResolvedValue(undefined);
  const controller = new AbortController();
  controller.abort();
  await expect(observe({}, controller.signal)).rejects.toThrow("requestCancelled");
  expect(editorDocument(tabId)!.version).toBe(0);
});

it("captures observation metadata before hashing and checks authorization again on completion", async () => {
  const digest = webcrypto.subtle.digest.bind(webcrypto.subtle);
  let resume!: () => void;
  const gate = new Promise<void>((resolve) => {
    resume = resolve;
  });
  vi.spyOn(webcrypto.subtle, "digest").mockImplementation(async (...args) => {
    await gate;
    return digest(...args);
  });
  const reading = observe();
  await vi.waitFor(() => expect(webcrypto.subtle.digest).toHaveBeenCalled());
  useEditors.getState().change(tabId, "changed during hash");
  resume();
  const captured = await reading;
  expect(captured.changed && captured.snapshot).toMatchObject({ version: 0, utf16Length: 7 });
  expect(await observe({ revision: captured.revision })).toMatchObject({
    changed: true,
    snapshot: { version: 1 },
  });
  mocks.invoke
    .mockResolvedValueOnce(undefined)
    .mockRejectedValueOnce(new Error("pluginSecurity.changed"));
  await expect(observe()).rejects.toThrow("pluginSecurity.changed");
});

it("drops a late observation after owner cancellation", async () => {
  const controller = new AbortController();
  mocks.invoke
    .mockImplementationOnce(() => undefined)
    .mockImplementationOnce(() => {
      controller.abort();
    });
  await expect(observe({}, controller.signal)).rejects.toThrow("requestCancelled");
});
