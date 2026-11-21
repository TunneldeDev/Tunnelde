import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";
import { createEditorWindowBinding } from "@/features/editor/editorWindowBinding";
import { executeEditorWindowAction } from "@/features/editor/editorWindowActions";
import {
  editorPatch,
  type EditorWindowModel,
  type EditorWindowCommand,
} from "@/features/editor/editorWindowModel";
import {
  useEditorWindowRegistrations,
  editorWindowIds,
} from "@/features/editor/editorWindowRegistration";
import { createPanelViewState } from "@/lib/panels/viewState";
import { useWindowViews, type WindowViewRecord } from "@/lib/panels/windowViews";
import type { PanelWindowClient } from "@/lib/panels/windowClient";
import { useEditors, undoEditorEdit, type EditorEntry } from "@/store/editors";
import { useWorkspace } from "@/store/workspace";
import { usePlugins } from "@/store/plugins";
import { api } from "@/lib/api/ipc";
import "@/i18n/i18n";
const id = "editor-view:00000000-0000-4000-8000-000000000001";
const tabId = "editor-local:/very/long/file.txt";
const lease = { panelId: id, windowId: "target", generation: 5 };
const sel = (n: number) => ({
  start: n,
  end: n,
  direction: "forward" as const,
  scrollTop: 23,
  scrollLeft: 7,
});
const entry: EditorEntry = {
  tabId,
  sessionId: null,
  path: "/file.txt",
  name: "file.txt",
  content: "one\r\n",
  baseline: "one\r\n",
  encoding: "utf-8",
  baselineEncoding: "utf-8",
  loading: false,
  saving: false,
  error: null,
  documentId: "doc-1",
  version: 0,
};
const model = (): EditorWindowModel => ({
  appearance: {} as EditorWindowModel["appearance"],
  language: "en",
  platform: "macos",
  tabId,
  editor: {
    entry: { ...useEditors.getState().entries[tabId]! },
    candidate: undefined,
    formatting: false,
    hasFormatter: false,
    commands: [],
    location: null,
    preferences: { wordWrap: false, tabSize: 2, spellCheck: false },
  },
});
const stops: (() => void)[] = [];
beforeEach(() => {
  useEditors.setState({ entries: { [tabId]: { ...entry } } });
  useEditorWindowRegistrations.setState({ entries: new Map([[tabId, id]]) });
  usePlugins.setState({ items: [] });
});
afterEach(() => {
  cleanup();
  stops
    .splice(0)
    .reverse()
    .forEach((s) => s());
  useEditors.getState().discard(tabId);
  useWindowViews.setState({ entries: new Map() });
  vi.restoreAllMocks();
});
function fixture(staged = false, capsule?: unknown) {
  const controller = createPanelViewState(capsule);
  const record: WindowViewRecord = {
    panelId: id,
    key: "target-generation",
    controller,
    staged,
    lease: staged ? undefined : lease,
  };
  useWindowViews.setState({ entries: new Map([[id, record]]) });
  const client = {
    windowId: "target",
    action: vi.fn((_lease, request) =>
      executeEditorWindowAction(_lease, request.command, async () => {}),
    ),
    control: vi.fn(async () => model()),
  } as unknown as PanelWindowClient;
  const binding = createEditorWindowBinding(client, record, model());
  const stop = binding.mount();
  stops.push(() => {
    stop();
    binding.dispose();
    controller.dispose();
  });
  const rendered = renderHook(() => binding.services.useModel(tabId));
  return { binding, client, controller, record, rendered };
}
it("uses short stable native IDs even for Windows and arbitrarily long local paths", () => {
  const long = `editor-local:/C:/${"路径/".repeat(400)}file.txt`;
  useWorkspace.setState({
    tabs: [{ id: long, kind: "editor", title: "file.txt", hostId: null, pinned: false }],
  });
  const [first] = editorWindowIds();
  expect(first).toMatch(/^editor-view:[a-f0-9-]{36}$/);
  expect(editorWindowIds()).toEqual([first]);
});
it("patches CRLF and surrogate text without normalizing source bytes", () => {
  for (const [before, after] of [
    ["a\r\nb", "a\r\n中😀b"],
    ["😀x", "😁x"],
    ["", "x"],
    ["abc", ""],
  ]) {
    const p = editorPatch(before!, after!);
    expect(before!.slice(0, p.from) + p.insert + before!.slice(p.to)).toBe(after);
  }
});
it("batches input to the main history, preserves CRLF, and restores undo selection", async () => {
  const { binding, client, rendered } = fixture();
  act(() => {
    binding.services.beforeInput(tabId, "insertText", sel(3));
    binding.services.change(tabId, "one!\r\n", sel(4));
    binding.services.beforeInput(tabId, "insertText", sel(4));
    binding.services.change(tabId, "one!?\r\n", sel(5));
  });
  expect(rendered.result.current.entry?.content).toBe("one!?\r\n");
  expect(useEditors.getState().entries[tabId]?.content).toBe("one\r\n");
  await act(() => binding.flush());
  expect(client.action).toHaveBeenCalledTimes(1);
  expect(useEditors.getState().entries[tabId]).toMatchObject({ content: "one!?\r\n", version: 2 });
  // Old publication after acknowledgement must NOT revert the optimistic buffer.
  act(() => binding.update({ ...model(), editor: { ...model().editor, entry: { ...entry } } }));
  expect(rendered.result.current.entry?.content).toBe("one!?\r\n");
  await act(async () => {
    binding.services.undo(tabId);
    await new Promise((r) => setTimeout(r, 5));
  });
  expect(useEditors.getState().entries[tabId]?.content).toBe("one\r\n");
  expect(binding.services.consumeSelection(tabId, "doc-1", 3, "one\r\n")).toMatchObject(sel(3));
});
it("validates a whole batch and format CAS before any text or history mutation", async () => {
  const command: EditorWindowCommand = {
    operation: "edit",
    data: {
      documentId: "doc-1",
      version: 0,
      encoding: "utf-8",
      edits: [
        { from: 3, to: 3, insert: "!", inputType: "insertText", before: sel(3), after: sel(4) },
        { from: 999, to: 999, insert: "bad", inputType: "insertText" },
      ],
    },
  };
  await expect(executeEditorWindowAction(lease, command, async () => {})).rejects.toThrow(
    "editor.documentChanged",
  );
  expect(useEditors.getState().entries[tabId]?.content).toBe(entry.content);
  expect(undoEditorEdit(tabId)).toBe(false);
  command.data.edits = [];
  command.data.encoding = "gbk";
  await expect(executeEditorWindowAction(lease, command, async () => {})).rejects.toThrow(
    "editor.documentChanged",
  );
});
it("blocks moves during IME and commits the entire composition as one undo item", async () => {
  const { binding, controller } = fixture();
  act(() => {
    binding.services.beginComposition(tabId, sel(3));
    binding.services.change(tabId, "one拼\r\n", sel(4));
    binding.services.change(tabId, "one拼音\r\n", sel(5));
  });
  await expect(controller.captureAsync()).rejects.toThrow("panel.window.moveInProgress");
  act(() => binding.services.endComposition(tabId, sel(5)));
  await act(() => binding.flush());
  expect(useEditors.getState().entries[tabId]?.content).toBe("one拼音\r\n");
  expect(undoEditorEdit(tabId)).toBe(true);
  expect(useEditors.getState().entries[tabId]?.content).toBe(entry.content);
  expect(undoEditorEdit(tabId)).toBe(false);
});
it("retains a rejected optimistic draft, freezes editing, and forbids a lossy move", async () => {
  const { binding, controller, rendered, client } = fixture();
  vi.mocked(client.action).mockImplementation(async (_lease, request) => {
    if (request.kind === "editor" && request.command.operation === "recover")
      throw new Error("backup failed");
    return executeEditorWindowAction(
      _lease,
      (request as { command: EditorWindowCommand }).command,
      async () => {},
    );
  });
  act(() => binding.services.change(tabId, "my draft", sel(8)));
  useEditors.setState((s) => ({
    entries: { ...s.entries, [tabId]: { ...entry, content: "external", version: 1 } },
  }));
  await act(async () => {
    await expect(binding.flush()).rejects.toThrow("editor.documentChanged");
  });
  act(() => binding.update(model()));
  expect(rendered.result.current.entry?.content).toBe("my draft");
  expect(rendered.result.current.frozen).toBe(true);
  await expect(controller.captureAsync()).rejects.toThrow();
  expect(useEditors.getState().entries[tabId]?.content).toBe("external");
});
it("rejects staged or retired input and never creates a second read/save resource", async () => {
  const read = vi.spyOn(api, "localReadText");
  const { binding, record } = fixture(true);
  expect(() => binding.services.change(tabId, "bad", sel(3))).toThrow();
  expect(read).not.toHaveBeenCalled();
  useWindowViews.setState({
    entries: new Map([[id, { ...record, key: "replacement", staged: false, lease }]]),
  });
  expect(() => binding.services.change(tabId, "bad", sel(3))).toThrow();
});
it("drains admitted edits before save and keeps format-only dirty drafts", async () => {
  const { binding } = fixture();
  const save = vi.spyOn(useEditors.getState(), "save").mockImplementation(async () => {
    expect(useEditors.getState().entries[tabId]?.content).toBe("dirty");
    return true;
  });
  act(() => binding.services.change(tabId, "dirty", sel(5)));
  await act(async () => {
    expect(await binding.services.save(tabId)).toBe(true);
  });
  expect(save).toHaveBeenCalledTimes(1);
  await act(async () => {
    binding.services.changeSaveEncoding(tabId, "utf-16le");
    await new Promise((r) => setTimeout(r, 5));
  });
  expect(useEditors.getState().entries[tabId]).toMatchObject({
    content: "dirty",
    encoding: "utf-16le",
    baselineEncoding: "utf-8",
  });
});
it("keeps selection-only capsules small and waits for real renderer readiness", async () => {
  const { binding, controller } = fixture();
  const lifetime = new AbortController();
  let ready = false;
  const wait = controller.waitReady(lifetime.signal).then(() => {
    ready = true;
  });
  await Promise.resolve();
  expect(ready).toBe(false);
  binding.services.rendered?.(true);
  await wait;
  binding.services.attachView?.(() => sel(3));
  const capsule = await controller.captureAsync();
  expect(capsule.fields).toEqual({
    "editor.selection": sel(3),
    "editor.revision": { documentId: "doc-1", version: 0 },
  });
  expect(JSON.stringify(capsule)).not.toContain(entry.content);
});

it("safely recovers an externally conflicting draft to a new main document before allowing close", async () => {
  const { binding, controller } = fixture();
  act(() => binding.services.change(tabId, "preserve this draft", sel(19)));
  useEditors.setState((s) => ({
    entries: { ...s.entries, [tabId]: { ...entry, content: "external", version: 1 } },
  }));
  await act(async () => {
    await expect(binding.flush()).rejects.toThrow("editor.documentChanged");
  });
  const recovery = Object.values(useEditors.getState().entries).find(
    (e) => e.tabId !== tabId && e.content === "preserve this draft",
  );
  expect(recovery).toMatchObject({ recovered: true, sessionId: null, path: entry.path });
  expect(useEditors.getState().entries[tabId]?.content).toBe("external");
  await expect(controller.captureAsync()).resolves.toBeDefined();
  useEditors.getState().discard(recovery!.tabId);
});

it("requests focus restoration only for actions initiated inside the editor", async () => {
  const { binding } = fixture();
  let focused = true;
  const focus = vi.fn();
  binding.services.attachView?.(
    () => sel(3),
    () => focused,
  );
  await act(async () => {
    await binding.services.save(tabId);
  });
  binding.services.resumeFocus?.(focus);
  expect(focus).toHaveBeenCalledTimes(1);
  focused = false;
  await act(async () => {
    await binding.services.save(tabId);
  });
  binding.services.resumeFocus?.(focus);
  expect(focus).toHaveBeenCalledTimes(1);
});

it("does not split emoji surrogate pairs across native JSON patch boundaries", () => {
  for (const [before, after] of [
    ["😀x", "😁x"],
    ["x😀", "y😁"],
    ["😀", "x😀"],
    ["x😀", "😀"],
  ]) {
    const patch = editorPatch(before!, after!);
    expect(new TextDecoder().decode(new TextEncoder().encode(patch.insert))).toBe(patch.insert);
    expect(before!.slice(0, patch.from) + patch.insert + before!.slice(patch.to)).toBe(after);
  }
});

it("does not acknowledge a staged editor using a stale pre-move model", async () => {
  const { binding, controller } = fixture(true, {
    version: 1,
    fields: { "editor.revision": { documentId: "doc-1", version: 1 } },
  });
  const abort = new AbortController();
  let ready = false;
  const wait = controller.waitReady(abort.signal).then(() => {
    ready = true;
  });
  binding.services.rendered?.(true);
  await Promise.resolve();
  expect(ready).toBe(false);
  useEditors.setState((s) => ({
    entries: { ...s.entries, [tabId]: { ...entry, version: 1, content: "newer draft" } },
  }));
  act(() => binding.update(model()));
  binding.services.rendered?.(true);
  await wait;
  expect(ready).toBe(true);
});
