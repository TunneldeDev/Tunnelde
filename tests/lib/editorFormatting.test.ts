import { beforeEach, describe, expect, it, vi } from "vitest";
import "@/i18n/i18n";
import { api } from "@/lib/api/ipc";
import * as ipc from "@/lib/api/ipc";
import * as security from "@/store/pluginSecurity";
import type { PluginInfo } from "@/lib/api/types";
import { usePlugins } from "@/store/plugins";
import { useWorkspace } from "@/store/workspace";
import { useEditors, editorDocument, replaceEditorDocument, undoEditorEdit } from "@/store/editors";
import {
  documentFormatters,
  formatEditorDocument,
  runEditorPlugin,
  useFormatting,
} from "@/lib/plugins/formatting";
import { bindingsFor, shortcutCommands, shortcutConflict } from "@/lib/keyboard/registry";
import { openPluginAction } from "@/lib/plugins/actions";

const plugin = {
  id: "formatter",
  name: "Formatter",
  runtime: "node",
  status: "running",
  permissions: ["editor.read", "editor.write"],
  fingerprint: "first",
  views: [],
  commands: [
    {
      id: "format",
      title: "Format JSON",
      editor: { extensions: ["json"], format: true },
      keybindings: ["Mod+Alt+J"],
      macKeybindings: ["Meta+Shift+J"],
    },
  ],
} as unknown as PluginInfo;
const provider = { id: plugin.id, command: "format", title: "Format JSON" };
const tabId = "editor:s1:/a.json";
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
beforeEach(async () => {
  for (const id of Object.keys(useEditors.getState().entries)) useEditors.getState().discard(id);
  vi.spyOn(api, "sftpReadText").mockResolvedValue({
    content: '{"value":9007199254740993}',
    size: 26,
  });
  vi.spyOn(api, "sftpWriteText").mockResolvedValue(undefined);
  vi.spyOn(api, "pluginRun").mockResolvedValue({ text: '{\n  "value": 9007199254740993\n}' });
  await useEditors.getState().open(tabId, "s1", "/a.json");
  usePlugins.setState({ items: [{ ...plugin }] });
  useWorkspace.setState({ activeId: tabId });
  useFormatting.setState({ busy: [], picker: null });
});

describe("editor document contracts and contributed formatters", () => {
  it("formats directly into the dirty buffer with one-step undo and redo; never saves", async () => {
    const document = editorDocument(tabId)!;
    expect(await runEditorPlugin(provider, document)).toBe(true);
    expect(api.pluginRun).toHaveBeenCalledWith(
      plugin.id,
      "format",
      expect.objectContaining({
        source: document.content,
        document: expect.objectContaining({ documentId: document.documentId, version: 0 }),
      }),
    );
    expect(useEditors.getState().entries[tabId]?.content).toContain("9007199254740993");
    expect(useEditors.getState().isDirty(tabId)).toBe(true);
    expect(api.sftpWriteText).not.toHaveBeenCalled();
    expect(undoEditorEdit(tabId)).toBe(true);
    expect(useEditors.getState().entries[tabId]?.content).toBe(document.content);
    expect(undoEditorEdit(tabId, true)).toBe(true);
    expect(useEditors.getState().entries[tabId]?.content).toContain('\n  "value"');
  });

  it("rejects stale snapshots even when typing changes away and back to the same text", async () => {
    const document = editorDocument(tabId)!;
    const pending = deferred<unknown>();
    vi.mocked(api.pluginRun).mockReturnValue(pending.promise);
    const operation = runEditorPlugin(provider, document);
    await vi.waitFor(() => expect(api.pluginRun).toHaveBeenCalled());
    useEditors.getState().change(tabId, "new draft");
    useEditors.getState().change(tabId, document.content);
    pending.resolve({ text: "stale" });
    expect(await operation).toBe(false);
    expect(useEditors.getState().entries[tabId]?.content).toBe(document.content);
  });

  it("rejects a result after close and reopen and does not target a different active editor", async () => {
    const document = editorDocument(tabId)!;
    const pending = deferred<unknown>();
    vi.mocked(api.pluginRun).mockReturnValue(pending.promise);
    const operation = runEditorPlugin(provider, document);
    await vi.waitFor(() => expect(api.pluginRun).toHaveBeenCalled());
    useEditors.getState().discard(tabId);
    await useEditors.getState().open(tabId, "s1", "/a.json");
    pending.resolve({ text: "stale" });
    expect(await operation).toBe(false);
    expect(editorDocument(tabId)?.documentId).not.toBe(document.documentId);
    expect(useEditors.getState().entries[tabId]?.content).toBe(document.content);
  });

  it("rejects invalid JSON errors, malformed results and revoked plugin responses without edits", async () => {
    const document = editorDocument(tabId)!;
    for (const result of [{ error: true, text: "Invalid JSON" }, { text: 123 }, null]) {
      vi.mocked(api.pluginRun).mockResolvedValueOnce(result);
      expect(await runEditorPlugin(provider, document)).toBe(false);
    }
    vi.mocked(api.pluginRun).mockImplementationOnce(async () => {
      usePlugins.setState({ items: [{ ...plugin, fingerprint: "replacement" }] });
      return { text: "replacement" };
    });
    expect(await runEditorPlugin(provider, document)).toBe(false);
    expect(useEditors.getState().entries[tabId]?.content).toBe(document.content);
  });

  it("does not read a newer document after consent or run when plugin startup is declined", async () => {
    const document = editorDocument(tabId)!;
    usePlugins.setState({ items: [{ ...plugin, status: "stopped" }] });
    const start = vi.spyOn(usePlugins.getState(), "start").mockResolvedValue(undefined);
    expect(await runEditorPlugin(provider, document)).toBe(false);
    expect(api.pluginRun).not.toHaveBeenCalled();
    start.mockImplementationOnce(async () => {
      usePlugins.setState({ items: [{ ...plugin }] });
      useEditors.getState().change(tabId, "latest");
    });
    expect(await runEditorPlugin(provider, document)).toBe(false);
    expect(api.pluginRun).not.toHaveBeenCalled();
  });

  it("selects matching declared providers only and asks when more than one is installed", () => {
    expect(documentFormatters("/HELLO.JSON", [plugin])).toHaveLength(1);
    expect(documentFormatters("/hello.json.txt", [plugin])).toEqual([]);
    usePlugins.setState({ items: [plugin, { ...plugin, id: "second" }] });
    formatEditorDocument(tabId);
    expect(useFormatting.getState().picker?.providers).toHaveLength(2);
    expect(api.pluginRun).not.toHaveBeenCalled();
  });

  it("registers plugin hotkeys with platform defaults, overrides and scope conflict detection", () => {
    const definitions = shortcutCommands([plugin]);
    const id = "plugin.c.9.formatter.format";
    expect(bindingsFor(id, {}, false, definitions)).toEqual(["Mod+Alt+J"]);
    expect(bindingsFor(id, {}, true, definitions)).toEqual(["Meta+Shift+J"]);
    expect(bindingsFor(id, { [id]: [] }, false, definitions)).toEqual([]);
    expect(shortcutConflict(id, "Mod+S", {}, definitions)?.id).toBe("editor.save");
  });

  it("runs a contributed editor action without opening a plugin result tab", async () => {
    const open = vi.spyOn(useWorkspace.getState(), "openPluginView");
    await openPluginAction({ id: plugin.id, command: "format" });
    expect(open).not.toHaveBeenCalled();
    expect(useEditors.getState().isDirty(tabId)).toBe(true);
  });

  it("keeps a queued editor action bound to the document active when it was requested", async () => {
    const pending = deferred<unknown>();
    usePlugins.setState({
      items: [{ ...plugin, commands: [{ id: "other", title: "Other" }, ...plugin.commands] }],
    });
    vi.spyOn(useWorkspace.getState(), "openPluginView").mockImplementation(() => {});
    vi.mocked(api.pluginRun).mockReturnValueOnce(pending.promise).mockResolvedValueOnce({
      text: "formatted original",
    });
    const first = openPluginAction({ id: plugin.id, command: "other" });
    const second = openPluginAction({ id: plugin.id, command: "format" });
    await vi.waitFor(() => expect(api.pluginRun).toHaveBeenCalledTimes(1));
    useWorkspace.setState({ activeId: "another-tab" });
    pending.resolve({ text: "done" });
    await Promise.all([first, second]);
    expect(api.pluginRun).toHaveBeenLastCalledWith(
      plugin.id,
      "format",
      expect.objectContaining({ document: expect.objectContaining({ tabId }) }),
    );
    expect(useEditors.getState().entries[tabId]?.content).toBe("formatted original");
  });

  it("bounds command requests and prevents two format operations from racing", async () => {
    const pending = deferred<unknown>();
    vi.mocked(api.pluginRun).mockReturnValue(pending.promise);
    const operation = runEditorPlugin(provider, editorDocument(tabId)!);
    expect(await runEditorPlugin(provider, editorDocument(tabId)!)).toBe(false);
    pending.resolve({ text: "formatted" });
    await operation;
    useEditors.getState().change(tabId, '"'.repeat(256 * 1024));
    expect(await runEditorPlugin(provider, editorDocument(tabId)!)).toBe(false);
    expect(api.pluginRun).toHaveBeenCalledTimes(1);
  });

  it("keeps the document contract narrow, rejects stale edits and supports empty buffers", () => {
    const document = editorDocument(tabId)!;
    expect(document).not.toHaveProperty("sessionId");
    expect(document).not.toHaveProperty("baseline");
    const updated = replaceEditorDocument(document, "");
    expect(updated.content).toBe("");
    expect(() => replaceEditorDocument(document, "stale")).toThrow("editor.documentChanged");
    useEditors.getState().markDisconnected("s1");
    expect(editorDocument(tabId)).toBeNull();
    expect(() => replaceEditorDocument(updated, "offline")).toThrow("editor.documentChanged");
  });

  it("does not send content when editor permission is denied or the document changes during consent", async () => {
    vi.spyOn(ipc, "isTauri").mockReturnValue(true);
    const ensure = vi.spyOn(security, "ensurePluginPermission").mockResolvedValue(false);
    const document = editorDocument(tabId)!;
    expect(await runEditorPlugin(provider, document)).toBe(false);
    expect(api.pluginRun).not.toHaveBeenCalled();
    ensure.mockImplementationOnce(async () => {
      useEditors.getState().change(tabId, "edited during consent");
      return true;
    });
    expect(await runEditorPlugin(provider, document)).toBe(false);
    expect(api.pluginRun).not.toHaveBeenCalled();
    expect(useEditors.getState().entries[tabId]?.content).toBe("edited during consent");
  });

  it("rejects revoked grants even if plugin metadata still reports running", async () => {
    vi.spyOn(ipc, "isTauri").mockReturnValue(true);
    vi.spyOn(security, "ensurePluginPermission").mockResolvedValue(true);
    security.usePluginSecurity.setState({
      state: {
        restricted: false,
        cliLocked: false,
        recoverySuggested: false,
        reason: null,
        grants: { formatter: plugin.permissions },
      },
    });
    const document = editorDocument(tabId)!;
    vi.mocked(api.pluginRun).mockImplementationOnce(async () => {
      security.usePluginSecurity.setState((state) => ({ state: { ...state.state, grants: {} } }));
      return { text: "revoked" };
    });
    expect(await runEditorPlugin(provider, document)).toBe(false);
    expect(useEditors.getState().entries[tabId]?.content).toBe(document.content);
  });

  it("propagates execution failures and oversized UTF-8 results without changing the document", async () => {
    const document = editorDocument(tabId)!;
    vi.mocked(api.pluginRun).mockRejectedValueOnce(new Error("formatter timed out"));
    expect(await runEditorPlugin(provider, document)).toBe(false);
    vi.mocked(api.pluginRun).mockResolvedValueOnce({ text: "中".repeat(45000) });
    expect(await runEditorPlugin(provider, document)).toBe(false);
    expect(useEditors.getState().entries[tabId]?.content).toBe(document.content);
    expect(useFormatting.getState().busy).toEqual([]);
  });
});
