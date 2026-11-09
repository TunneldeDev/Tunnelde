import * as keyboardActions from "@/lib/keyboard/actions";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import "@/i18n/i18n";
import { EditorPage } from "@/features/editor/EditorPage";
import { DEFAULT_SETTINGS } from "@/lib/prefs/defaults";
import { useEditors, type EditorEntry } from "@/store/editors";
import { useSettings } from "@/store/settings";
import { useSsh } from "@/store/ssh";
import { useWorkspace } from "@/store/workspace";
import { api } from "@/lib/api/ipc";
import { usePlugins } from "@/store/plugins";
import type { PluginInfo } from "@/lib/api/types";
import { useFormatting } from "@/lib/plugins/formatting";

const entry: EditorEntry = {
  tabId: "editor",
  sessionId: "s1",
  path: "/draft.txt",
  name: "draft.txt",
  content: "\tunsaved draft\r\n\tsecond line\r\n",
  baseline: "original\r\n",
  loading: false,
  saving: false,
  error: null,
};

beforeEach(() => {
  useEditors.setState({ entries: { editor: { ...entry } } });
  useSettings.setState({ settings: { ...DEFAULT_SETTINGS } });
  useWorkspace.setState({ tabs: [] });
  useSsh.setState({ sessions: [] });
  usePlugins.setState({ items: [] });
  useFormatting.setState({ busy: [], picker: null });
});

describe("editor formatting shortcuts", () => {
  const prepare = () => {
    const json = {
      ...entry,
      name: "test.json",
      path: "/test.json",
      content: '{"a":1}',
      baseline: '{"a":1}',
    };
    useEditors.setState({ entries: { editor: json } });
    useWorkspace.setState({ activeId: "editor" });
    usePlugins.setState({
      items: [
        {
          id: "formatter",
          name: "Formatter",
          runtime: "node",
          status: "running",
          views: [],
          permissions: ["editor.read", "editor.write"],
          commands: [
            {
              id: "pretty",
              title: "Format",
              keybindings: ["Mod+Shift+F"],
              editor: { extensions: ["json"], format: true },
            },
          ],
        },
      ] as unknown as PluginInfo[],
    });
    vi.spyOn(api, "pluginRun").mockResolvedValue({ text: '{\n    "a": 1\n}' });
    vi.spyOn(api, "sftpWriteText").mockResolvedValue(undefined);
    render(<EditorPage tabId="editor" active />);
    return screen.getByRole("textbox", { name: "test.json" });
  };

  it.each(["ctrlKey", "metaKey"] as const)(
    "formats with %s and supports one-step undo and redo",
    async (modifier) => {
      const textarea = prepare();
      textarea.focus();
      fireEvent.keyDown(textarea, { key: "F", shiftKey: true, [modifier]: true });
      await waitFor(() => expect(textarea).toHaveProperty("value", '{\n    "a": 1\n}'));
      expect(api.sftpWriteText).not.toHaveBeenCalled();
      fireEvent.keyDown(textarea, { key: "z", [modifier]: true });
      expect(textarea).toHaveProperty("value", '{"a":1}');
      fireEvent.keyDown(textarea, { key: "Z", shiftKey: true, [modifier]: true });
      expect(textarea).toHaveProperty("value", '{\n    "a": 1\n}');
      fireEvent(
        textarea,
        new InputEvent("beforeinput", {
          inputType: "historyUndo",
          bubbles: true,
          cancelable: true,
        }),
      );
      expect(textarea).toHaveProperty("value", '{"a":1}');
    },
  );

  it("honors a customized binding without stealing the original content-search chord", async () => {
    const textarea = prepare();
    act(() =>
      useSettings.setState({
        settings: {
          ...DEFAULT_SETTINGS,
          keyboardShortcuts: { "plugin.c.9.formatter.pretty": ["Mod+Alt+J"] },
        },
      }),
    );
    const original = new KeyboardEvent("keydown", {
      key: "F",
      ctrlKey: true,
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    fireEvent(textarea, original);
    expect(original.defaultPrevented).toBe(false);
    expect(api.pluginRun).not.toHaveBeenCalled();
    fireEvent.keyDown(textarea, { key: "j", ctrlKey: true, altKey: true });
    await waitFor(() => expect(api.pluginRun).toHaveBeenCalledTimes(1));
  });

  it("runs both applicable plugin commands when their shortcuts conflict", async () => {
    const textarea = prepare();
    act(() =>
      usePlugins.setState((state) => ({
        items: [...state.items, { ...state.items[0]!, id: "second", name: "Second" }],
      })),
    );
    fireEvent.keyDown(textarea, { key: "F", ctrlKey: true, shiftKey: true });
    await waitFor(() => expect(api.pluginRun).toHaveBeenCalledTimes(2));
    expect(vi.mocked(api.pluginRun).mock.calls.map((call) => call[0])).toEqual([
      "formatter",
      "second",
    ]);
  });

  it("blocks lower-priority editor plugins after accepting the preferred formatter", async () => {
    const textarea = prepare();
    act(() => {
      usePlugins.setState((state) => ({
        items: [...state.items, { ...state.items[0]!, id: "second", name: "Second" }],
      }));
      useSettings.setState({
        settings: {
          ...DEFAULT_SETTINGS,
          shortcutRules: {
            "plugin.c.6.second.pretty": { "Mod+Shift+F": { priority: 500, propagation: "block" } },
          },
        },
      });
    });
    fireEvent.keyDown(textarea, { key: "F", ctrlKey: true, shiftKey: true });
    await waitFor(() => expect(api.pluginRun).toHaveBeenCalledTimes(1));
    expect(vi.mocked(api.pluginRun).mock.calls[0]?.[0]).toBe("second");
  });

  it("keeps a queued formatter bound to the editor when a shared workbench command changes tabs", async () => {
    const textarea = prepare();
    const run = vi.spyOn(keyboardActions, "runWorkbenchCommand").mockImplementation(() => {
      useWorkspace.setState({ activeId: "other" });
      return true;
    });
    fireEvent.keyDown(textarea, { key: "F", ctrlKey: true, shiftKey: true });
    await waitFor(() => expect(api.pluginRun).toHaveBeenCalledTimes(1));
    expect(vi.mocked(api.pluginRun).mock.calls[0]?.[2]).toMatchObject({
      document: { tabId: "editor" },
    });
    expect(useEditors.getState().entries.editor?.content).toContain('"a": 1');
    run.mockRestore();
  });

  it("runs both matching editor commands contributed by one plugin in sequence", async () => {
    const textarea = prepare();
    act(() =>
      usePlugins.setState((state) => ({
        items: state.items.map((item) => ({
          ...item,
          commands: [...item.commands, { ...item.commands[0]!, id: "second" }],
        })),
      })),
    );
    fireEvent.keyDown(textarea, { key: "F", ctrlKey: true, shiftKey: true });
    await waitFor(() => expect(api.pluginRun).toHaveBeenCalledTimes(2));
    expect(vi.mocked(api.pluginRun).mock.calls.map((call) => call[1])).toEqual([
      "pretty",
      "second",
    ]);
  });

  it("does not capture an editor plugin shortcut for an unsupported extension", () => {
    const textarea = prepare();
    act(() => useEditors.setState({ entries: { editor: { ...entry } } }));
    const event = new KeyboardEvent("keydown", {
      key: "F",
      ctrlKey: true,
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    fireEvent(textarea, event);
    expect(event.defaultPrevented).toBe(false);
    expect(api.pluginRun).not.toHaveBeenCalled();
  });

  it("updates the format action as matching providers are installed, removed, or the file changes", () => {
    prepare();
    const label = /格式化文档|Format document/i;
    expect(screen.getByRole("button", { name: label })).toHaveProperty("disabled", false);
    act(() => useEditors.setState({ entries: { editor: { ...entry } } }));
    expect(screen.queryByRole("button", { name: label })).toBeNull();
    act(() => useEditors.setState({ entries: { editor: { ...entry, path: "/test.JSON" } } }));
    expect(screen.getByRole("button", { name: label })).toHaveProperty("disabled", false);
    const plugins = usePlugins.getState().items;
    act(() => usePlugins.setState({ items: [] }));
    expect(screen.queryByRole("button", { name: label })).toBeNull();
    act(() => usePlugins.setState({ items: plugins }));
    expect(screen.getByRole("button", { name: label })).toHaveProperty("disabled", false);
  });

  it("does not offer formatting for editor commands without a formatter contribution", () => {
    prepare();
    act(() =>
      usePlugins.setState((state) => ({
        items: state.items.map((plugin) => ({
          ...plugin,
          commands: plugin.commands.map((command) => ({
            ...command,
            editor: { extensions: ["json"], format: false },
          })),
        })),
      })),
    );
    expect(screen.queryByRole("button", { name: /格式化文档|Format document/i })).toBeNull();
  });

  it("retains the disabled progress action until an in-flight formatter finishes after uninstall", () => {
    prepare();
    act(() => useFormatting.setState({ busy: ["editor"] }));
    act(() => usePlugins.setState({ items: [] }));
    expect(screen.getByRole("button", { name: /正在格式化|Formatting/i })).toHaveProperty(
      "disabled",
      true,
    );
    act(() => useFormatting.setState({ busy: [] }));
    expect(
      screen.queryByRole("button", { name: /格式化文档|Format document|正在格式化|Formatting/i }),
    ).toBeNull();
  });

  it("does not capture keys from a different visible editor", async () => {
    prepare();
    const other = { ...entry, tabId: "other", path: "/other.txt", name: "other.txt" };
    act(() => useEditors.setState((state) => ({ entries: { ...state.entries, other } })));
    render(<EditorPage tabId="other" active={false} />);
    const event = new KeyboardEvent("keydown", {
      key: "F",
      ctrlKey: true,
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    fireEvent(screen.getByRole("textbox", { name: "other.txt" }), event);
    expect(event.defaultPrevented).toBe(false);
    expect(api.pluginRun).not.toHaveBeenCalled();
  });
});

describe("EditorPage preferences", () => {
  it("updates wrapping, tab width, and spellcheck without changing the draft or dirty state", () => {
    render(<EditorPage tabId="editor" active />);
    const textarea = screen.getByRole("textbox", { name: "draft.txt" }) as HTMLTextAreaElement;
    expect(textarea.wrap).toBe("off");
    expect(textarea.style.tabSize).toBe("4");
    expect(textarea.getAttribute("spellcheck")).toBe("false");
    act(() =>
      useSettings.setState({
        settings: {
          ...DEFAULT_SETTINGS,
          editorWordWrap: true,
          editorTabSize: 8,
          editorSpellCheck: true,
        },
      }),
    );
    expect(textarea.wrap).toBe("soft");
    expect(textarea.style.whiteSpace).toBe("pre-wrap");
    expect(textarea.style.tabSize).toBe("8");
    expect(textarea.getAttribute("spellcheck")).toBe("true");
    expect(useEditors.getState().entries.editor).toEqual(entry);
    expect(useEditors.getState().isDirty("editor")).toBe(true);
    act(() => useSettings.setState({ settings: { ...DEFAULT_SETTINGS } }));
    expect(textarea.wrap).toBe("off");
    expect(useEditors.getState().entries.editor?.content).toBe(entry.content);
  });
});
