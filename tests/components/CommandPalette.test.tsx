import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import "@/i18n/i18n";
import { CommandPalette } from "@/components/layout/CommandPalette";
import { DEFAULT_SETTINGS } from "@/lib/prefs/defaults";
import { useDialogs } from "@/store/dialogs";
import { useQuickAccess } from "@/store/quickAccess";
import { useHosts } from "@/store/hosts";
import { useNavigation } from "@/store/navigation";
import { useSettings } from "@/store/settings";
import { useWorkspace } from "@/store/workspace";
import { usePlugins } from "@/store/plugins";
import { useSearchRoots } from "@/store/searchRoots";
import { useSsh } from "@/store/ssh";
import { useEditors } from "@/store/editors";
import { useEditorLocation } from "@/store/editorLocation";
import { api } from "@/lib/api/ipc";
import type { Host, PluginInfo, SshSession } from "@/lib/api/types";

beforeEach(() => {
  useQuickAccess.setState({ query: ">" });
  usePlugins.setState({ items: [], outputs: {} });
  useSearchRoots.setState({ roots: {} });
  useSsh.setState({ sessions: [] });
  useEditors.setState({ entries: {} });
  useWorkspace.setState({
    tabs: [],
    panes: [{ id: "pane-1", tabIds: [], activeId: null }],
    activePaneId: "pane-1",
    activeId: null,
    split: null,
  });
  useSettings.setState({ settings: DEFAULT_SETTINGS });
  useHosts.setState({ hosts: [] });
  useNavigation.setState({
    activeSidebar: "hosts",
    sidebarVisible: false,
    visitedSidebars: ["hosts"],
  });
});

describe("CommandPalette", () => {
  it("pages all matching plugin commands instead of silently dropping results after 100", () => {
    usePlugins.setState({
      items: [
        {
          id: "batch",
          name: "Batch",
          runtime: "node",
          status: "stopped",
          views: [],
          commands: Array.from({ length: 145 }, (_, index) => ({
            id: `item${index}`,
            title: `Item ${index}`,
          })),
        } as unknown as PluginInfo,
      ],
    });
    const start = vi.spyOn(usePlugins.getState(), "start");
    useQuickAccess.getState().show(">Batch");
    render(<CommandPalette />);
    expect(screen.getAllByRole("option")).toHaveLength(100);
    expect(screen.getByRole("status").textContent).toBe("1–100 / 145");
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    expect(screen.getAllByRole("option")).toHaveLength(45);
    expect(screen.getByRole("status").textContent).toBe("101–145 / 145");
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "ArrowUp" });
    expect(screen.getAllByRole("option")).toHaveLength(100);
    expect(screen.getAllByRole("option")[99]!.getAttribute("aria-selected")).toBe("true");
    expect(start).not.toHaveBeenCalled();
  });
  it("reports the collected unsaved-content limit instead of silently hiding extra matches", () => {
    useQuickAccess.getState().show("% match");
    const tabId = "editor-local:C:/work/a.txt";
    useEditors.setState({
      entries: {
        [tabId]: {
          tabId,
          sessionId: null,
          path: "C:/work/a.txt",
          name: "a.txt",
          content: Array(101).fill("match").join("\n"),
          baseline: "",
          loading: false,
          saving: false,
          error: null,
        },
      },
    });
    render(<CommandPalette />);
    expect(screen.getAllByRole("option")).toHaveLength(100);
    expect(screen.getByRole("status").textContent).toContain("100 results");
  });
  it("keeps explicit host mode while inserting @tag presets", () => {
    useQuickAccess.setState({ query: "@ " });
    useHosts.setState({
      hosts: [
        {
          id: "qa",
          name: "QA host",
          host: "192.0.2.1",
          username: "qa",
          tags: ["production"],
          favorite: false,
        } as Host,
      ],
    });
    render(<CommandPalette />);
    fireEvent.click(screen.getByRole("button", { name: "Filter presets" }));
    fireEvent.click(screen.getByText("@tag:production").closest("button")!);
    expect((screen.getByRole("combobox") as HTMLInputElement).value).toBe("@ @tag:production");
    expect(screen.getByRole("option", { name: /^Connect · QA host/ })).toBeTruthy();
  });
  it("applies file qualifiers to unsaved content without losing eligible draft results", async () => {
    useQuickAccess.setState({ query: "% match @ext:json" });
    useSearchRoots.setState({
      roots: { files: [{ id: "root", path: "C:/work", sessionId: null }] },
    });
    const entries = Object.fromEntries(
      ["one.json", "two.md"].map((name) => {
        const tabId = `editor-local:C:/work/${name}`;
        return [
          tabId,
          {
            tabId,
            sessionId: null,
            path: `C:/work/${name}`,
            name,
            content: "draft match",
            baseline: "old",
            loading: false,
            saving: false,
            error: null,
          },
        ];
      }),
    );
    useEditors.setState({ entries });
    vi.spyOn(api, "filesSearch").mockResolvedValue({ matches: [], limited: false, skipped: 0 });
    render(<CommandPalette />);
    expect(screen.getAllByRole("option")).toHaveLength(1);
    expect(screen.getByRole("option").textContent).toContain("one.json");
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "% match @ext:md" } });
    expect(screen.getAllByRole("option")).toHaveLength(1);
    expect(screen.getByRole("option").textContent).toContain("two.md");
  });

  it("keeps literal content whitespace and sends path/extension qualifiers to the traversal", async () => {
    useQuickAccess.setState({ query: "% Foo  Bar @ext:json,md -@path:vendor" });
    useSearchRoots.setState({
      roots: { files: [{ id: "root", path: "C:/work", sessionId: null }] },
    });
    const search = vi
      .spyOn(api, "filesSearch")
      .mockResolvedValue({ matches: [], limited: false, skipped: 0 });
    render(<CommandPalette />);
    await waitFor(() =>
      expect(search).toHaveBeenCalledWith(expect.any(String), null, "C:/work", "Foo  Bar", true, {
        text: [],
        filters: [
          { key: "ext", values: ["json", "md"], exclude: false },
          { key: "path", values: ["vendor"], exclude: true },
        ],
      }),
    );
  });

  it("supports qualifier-only file searches and exposes presets for commands", async () => {
    useQuickAccess.setState({ query: "@ext:json,md" });
    useSearchRoots.setState({
      roots: { files: [{ id: "root", path: "C:/work", sessionId: null }] },
    });
    const search = vi.spyOn(api, "filesSearch").mockResolvedValue({
      matches: [
        { path: "C:/work/one.json", line: 0, column: 0, preview: "one.json" },
        { path: "C:/work/two.md", line: 0, column: 0, preview: "two.md" },
      ],
      limited: false,
      skipped: 0,
    });
    render(<CommandPalette />);
    await waitFor(() =>
      expect(search).toHaveBeenCalledWith(expect.any(String), null, "C:/work", "", false, {
        text: [],
        filters: [{ key: "ext", values: ["json", "md"], exclude: false }],
      }),
    );
    expect(await screen.findByRole("option", { name: /one.json/ })).toBeTruthy();
    expect(screen.getByRole("option", { name: /two.md/ })).toBeTruthy();
    fireEvent.change(screen.getByRole("combobox"), {
      target: { value: ">@category:Application restart" },
    });
    expect(screen.getByRole("option", { name: /Restart Tunnelde/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Filter presets" })).toBeTruthy();
  });

  it("offers restart and reload as separate searchable commands", () => {
    useDialogs.getState().close();
    render(<CommandPalette />);
    const input = screen.getByRole("combobox");
    fireEvent.change(input, { target: { value: ">restart tunnelde" } });
    expect(screen.getByText("Restart Tunnelde")).toBeTruthy();
    fireEvent.change(input, { target: { value: ">reload window" } });
    expect(screen.getByText("Reload window")).toBeTruthy();
    fireEvent.keyDown(input, { key: "Enter" });
    const dialog = useDialogs.getState().dialog;
    expect(dialog.kind).toBe("confirm");
    if (dialog.kind === "confirm") expect(dialog.title).toBe("Reload window?");
    useDialogs.getState().close();
  });

  it("keeps an existing local search root selected when choosing the same folder", async () => {
    useQuickAccess.setState({ query: "" });
    useSearchRoots.setState({
      roots: { files: [{ id: "local-root", path: "C:/work", sessionId: null }] },
    });
    vi.spyOn(api, "pluginPickFolder").mockResolvedValue("C:/work");
    const search = vi.spyOn(api, "filesSearch").mockResolvedValue({
      matches: [],
      limited: false,
      skipped: 0,
    });
    render(<CommandPalette />);
    fireEvent.click(screen.getByRole("button", { name: "Choose local search folder" }));
    await waitFor(() => expect(api.pluginPickFolder).toHaveBeenCalled());
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "readme" } });
    await waitFor(() =>
      expect(search).toHaveBeenCalledWith(expect.any(String), null, "C:/work", "readme", false),
    );
  });

  it("opens local content search results in the editor at the matching line", async () => {
    useQuickAccess.setState({ query: "% target" });
    useSearchRoots.setState({
      roots: { files: [{ id: "local-root", path: "C:/work", sessionId: null }] },
    });
    vi.spyOn(api, "filesSearch").mockResolvedValue({
      matches: [{ path: "C:/work/a.txt", line: 3, column: 4, preview: "target" }],
      limited: false,
      skipped: 0,
    });
    vi.spyOn(api, "filesSearchCancel").mockResolvedValue();
    vi.spyOn(api, "localReadText").mockResolvedValue({ content: "one\ntwo\ntarget", size: 14 });
    render(<CommandPalette />);
    fireEvent.click(await screen.findByRole("option", { name: /target/ }));
    expect(useWorkspace.getState().activeId).toBe("editor-local:C:/work/a.txt");
    expect(useEditorLocation.getState().target).toEqual({
      tabId: "editor-local:C:/work/a.txt",
      line: 3,
      column: 4,
    });
    await waitFor(() =>
      expect(useEditors.getState().entries["editor-local:C:/work/a.txt"]?.content).toBe(
        "one\ntwo\ntarget",
      ),
    );
  });

  it("searches unsaved local editor content across Windows path separators", async () => {
    useQuickAccess.setState({ query: "% target" });
    useSearchRoots.setState({
      roots: { files: [{ id: "local", path: "C:/WORK", sessionId: null }] },
    });
    const tabId = "editor-local:C:\\work\\a.txt";
    useEditors.setState({
      entries: {
        [tabId]: {
          tabId,
          sessionId: null,
          path: "C:\\work\\a.txt",
          name: "a.txt",
          content: "unsaved target",
          baseline: "disk",
          loading: false,
          saving: false,
          error: null,
        },
      },
    });
    vi.spyOn(api, "filesSearch").mockResolvedValue({
      matches: [{ path: "C:\\work\\a.txt", line: 1, column: 1, preview: "disk target" }],
      limited: false,
      skipped: 0,
    });
    vi.spyOn(api, "filesSearchCancel").mockResolvedValue();
    render(<CommandPalette />);
    expect(await screen.findByText("unsaved target")).toBeTruthy();
    expect(screen.queryByText("disk target")).toBeNull();
  });

  it("uses the Windows editor's parent as the search root without a file panel", async () => {
    useQuickAccess.setState({ query: "% target" });
    const tabId = "editor-local:C:\\work\\a.txt";
    useEditors.setState({
      entries: {
        [tabId]: {
          tabId,
          sessionId: null,
          path: "C:\\work\\a.txt",
          name: "a.txt",
          content: "unsaved target",
          baseline: "disk",
          loading: false,
          saving: false,
          error: null,
        },
      },
    });
    const search = vi.spyOn(api, "filesSearch").mockResolvedValue({
      matches: [
        { path: "C:/WORK/a.txt", line: 1, column: 1, preview: "stale target" },
        { path: "C:/work/b.txt", line: 1, column: 1, preview: "sibling target" },
      ],
      limited: false,
      skipped: 0,
    });
    vi.spyOn(api, "filesSearchCancel").mockResolvedValue();
    render(<CommandPalette />);
    await waitFor(() =>
      expect(search).toHaveBeenCalledWith(expect.any(String), null, "C:\\work", "target", true),
    );
    expect(await screen.findByText("sibling target")).toBeTruthy();
    expect(screen.getByText("unsaved target")).toBeTruthy();
    expect(screen.queryByText("stale target")).toBeNull();
  });

  it("keeps literal backslashes in remote search scopes and excludes similarly named directories", async () => {
    useQuickAccess.setState({ query: "% target" });
    useSsh.setState({ sessions: [{ id: "ssh", title: "Remote" } as SshSession] });
    useSearchRoots.setState({
      roots: { files: [{ id: "remote", path: "/work\\literal", sessionId: "ssh" }] },
    });
    useEditors.setState({
      entries: Object.fromEntries(
        [
          ["inside", "/work\\literal/a.txt", "inside target"],
          ["outside", "/work/literal/b.txt", "outside target"],
        ].map(([tabId, path, content]) => [
          tabId!,
          {
            tabId: tabId!,
            sessionId: "ssh",
            path: path!,
            name: "a.txt",
            content: content!,
            baseline: "disk",
            loading: false,
            saving: false,
            error: null,
          },
        ]),
      ),
    });
    vi.spyOn(api, "filesSearch").mockResolvedValue({ matches: [], limited: false, skipped: 0 });
    vi.spyOn(api, "filesSearchCancel").mockResolvedValue();
    render(<CommandPalette />);
    expect(await screen.findByText("inside target")).toBeTruthy();
    expect(screen.queryByText("outside target")).toBeNull();
  });

  it("lists plugin metadata without starting a runtime and executes a command into its result page", async () => {
    const plugin = {
      id: "uuid",
      name: "UUID Generator",
      runtime: "node",
      status: "running",
      views: [],
      commands: [{ id: "generate", title: "Generate UUIDs" }],
    } as unknown as PluginInfo;
    usePlugins.setState({ items: [plugin] });
    const start = vi.spyOn(usePlugins.getState(), "start");
    const run = vi
      .spyOn(api, "pluginRun")
      .mockResolvedValue({ text: "first-uuid\nsecond-uuid", title: "UUIDs" });
    render(<CommandPalette />);
    const input = screen.getByRole("combobox");
    fireEvent.change(input, { target: { value: "> UUID Generate" } });
    expect(start).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    expect(run).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() =>
      expect(usePlugins.getState().outputs.uuid?.text).toBe("first-uuid\nsecond-uuid"),
    );
    expect(useWorkspace.getState().activeId).toBe("plugin:uuid:$command");
  });

  it("cancels obsolete content searches, ignores their late results and preserves dirty editor text", async () => {
    const session = { id: "ssh", hostId: "host", title: "Development" } as SshSession;
    useSsh.setState({ sessions: [session] });
    useSearchRoots.setState({
      roots: { files: [{ id: "remote-root", path: "/work", sessionId: "ssh" }] },
    });
    let finishOld!: (value: Awaited<ReturnType<typeof api.filesSearch>>) => void;
    const search = vi
      .spyOn(api, "filesSearch")
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishOld = resolve;
          }),
      )
      .mockResolvedValue({
        matches: [{ path: "/work/a.txt", line: 1, column: 1, preview: "disk: match" }],
        limited: false,
        skipped: 0,
      });
    const cancel = vi.spyOn(api, "filesSearchCancel").mockResolvedValue();
    const tabId = "editor:ssh:/work/a.txt";
    useEditors.setState({
      entries: {
        [tabId]: {
          tabId,
          sessionId: "ssh",
          path: "/work/a.txt",
          name: "a.txt",
          content: "unsaved\nmy match",
          baseline: "old",
          loading: false,
          saving: false,
          error: null,
        },
      },
    });
    useQuickAccess.setState({ query: "% old" });
    render(<CommandPalette />);
    await waitFor(() => expect(search).toHaveBeenCalledTimes(1));
    const oldRequest = search.mock.calls[0]![0];
    fireEvent.change(
      screen.getByRole("combobox", {
        name: "Search files, or type > commands, % content, @ hosts",
      }),
      { target: { value: "% match" } },
    );
    await waitFor(() => expect(search).toHaveBeenCalledTimes(2));
    expect(cancel).toHaveBeenCalledWith(oldRequest);
    await act(async () =>
      finishOld({
        matches: [{ path: "/work/stale.txt", line: 1, column: 1, preview: "old" }],
        limited: false,
        skipped: 0,
      }),
    );
    expect(screen.queryByText("disk: match")).toBeNull();
    expect(screen.queryByText("/work/stale.txt:1:1")).toBeNull();
    fireEvent.click(screen.getByRole("option", { name: /my match/ }));
    expect(useEditors.getState().entries[tabId]?.content).toBe("unsaved\nmy match");
    expect(useEditorLocation.getState().target).toEqual({ tabId, line: 2, column: 4 });
  });
  it("filters commands while typing", () => {
    render(<CommandPalette />);
    fireEvent.change(
      screen.getByPlaceholderText("Search files, or type > commands, % content, @ hosts"),
      {
        target: { value: ">welcome" },
      },
    );
    expect(screen.getByRole("option", { name: "Welcome Category: Application" })).toBeTruthy();
    expect(screen.queryByRole("option", { name: "Settings" })).toBeNull();
  });

  it("runs the highlighted command with Enter", () => {
    const onClose = vi.spyOn(useQuickAccess.getState(), "close");
    render(<CommandPalette />);
    const input = screen.getByPlaceholderText(
      "Search files, or type > commands, % content, @ hosts",
    );
    fireEvent.change(input, { target: { value: ">settings" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onClose).toHaveBeenCalled();
    expect(useWorkspace.getState().tabs.map((tab) => tab.kind)).toContain("settings");
  });

  it("reports when nothing matches", () => {
    render(<CommandPalette />);
    fireEvent.change(
      screen.getByPlaceholderText("Search files, or type > commands, % content, @ hosts"),
      {
        target: { value: ">zzzz" },
      },
    );
    expect(screen.getByText("No results")).toBeTruthy();
  });

  it("opens the trusted-host sidebar without creating a tab", () => {
    render(<CommandPalette />);
    const input = screen.getByPlaceholderText(
      "Search files, or type > commands, % content, @ hosts",
    );
    fireEvent.change(input, { target: { value: ">Trusted hosts" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(useNavigation.getState().activeSidebar).toBe("knownHosts");
    expect(useNavigation.getState().sidebarVisible).toBe(true);
    expect(useWorkspace.getState().tabs).toEqual([]);
  });

  it("keeps the panel toggle accessible when the status bar is hidden", () => {
    const update = vi.fn().mockResolvedValue(true);
    useSettings.setState({ settings: { ...DEFAULT_SETTINGS, showStatusBar: false }, update });
    render(<CommandPalette />);
    const input = screen.getByPlaceholderText(
      "Search files, or type > commands, % content, @ hosts",
    );
    fireEvent.change(input, { target: { value: ">Show panel" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(update).toHaveBeenCalledWith({ rightPanel: true });
  });
});
