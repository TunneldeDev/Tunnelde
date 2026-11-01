// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import "@/i18n/i18n";
import { EditorPage } from "@/features/editor/EditorPage";
import { DEFAULT_SETTINGS } from "@/lib/prefs/defaults";
import { useEditors, type EditorEntry } from "@/store/editors";
import { useSettings } from "@/store/settings";
import { useSsh } from "@/store/ssh";
import { useWorkspace } from "@/store/workspace";

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
