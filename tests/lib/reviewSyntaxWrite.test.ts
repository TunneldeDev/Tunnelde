import { beforeEach, expect, it, vi } from "vitest";
import "@/i18n/i18n";
import { api } from "@/lib/api/ipc";
import * as ipc from "@/lib/api/ipc";
import { usePlugins } from "@/store/plugins";
import { usePluginSecurity } from "@/store/pluginSecurity";
import { useEditors, editorDocument } from "@/store/editors";
import { useWorkspace } from "@/store/workspace";
import { openPluginAction } from "@/lib/plugins/actions";
import { runEditorPlugin } from "@/lib/plugins/formatting";
import { shortcutCommands } from "@/lib/keyboard/registry";
import type { PluginInfo } from "@/lib/api/types";

const readOnly = {
  id: "read-only-syntax",
  name: "Read-only syntax",
  runtime: "node",
  status: "running",
  runtimeId: "boot:1",
  fingerprint: "first",
  permissions: ["editor.read"],
  views: [],
  commands: [{ id: "highlight", title: "Highlight", editor: { extensions: ["js"], syntax: true } }],
} as unknown as PluginInfo;
const writable = {
  ...readOnly,
  id: "formatter",
  permissions: ["editor.read", "editor.write"],
  commands: [
    {
      id: "format",
      title: "Format",
      editor: { extensions: ["js"], syntax: true, format: true },
    },
  ],
} as unknown as PluginInfo;
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
};
beforeEach(() => {
  vi.spyOn(ipc, "isTauri").mockReturnValue(true);
  usePlugins.setState({ items: [{ ...readOnly }], stoppingIds: [] });
  usePluginSecurity.setState({
    ready: true,
    state: {
      restricted: false,
      cliLocked: false,
      recoverySuggested: false,
      reason: null,
      grants: { [readOnly.id]: ["editor.read"] },
    },
  });
  useEditors.setState({
    entries: {
      review: {
        tabId: "review",
        documentId: "doc",
        version: 0,
        sessionId: null,
        path: "/a.js",
        name: "a.js",
        content: "const original = 1;",
        baseline: "const original = 1;",
        loading: false,
        saving: false,
        error: null,
      },
    },
  });
  useWorkspace.setState({ activeId: "review" });
  vi.spyOn(api, "pluginRun").mockResolvedValue({ text: "OVERWRITTEN WITHOUT editor.write" });
});
it("read-only syntax contribution cannot replace a document via explicit action", async () => {
  await openPluginAction({ id: readOnly.id, command: "highlight" });
  expect(api.pluginRun).not.toHaveBeenCalled();
  expect(editorDocument("review")?.content).toBe("const original = 1;");
});
it("read-only syntax contribution cannot enter the formatter shortcut path", async () => {
  expect(shortcutCommands([readOnly]).some((item) => item.plugin?.command === "highlight")).toBe(
    false,
  );
});
it("direct formatter invocation rejects a syntax-only declaration even with both grants", async () => {
  const plugin = { ...readOnly, permissions: ["editor.read", "editor.write"] } as PluginInfo;
  usePlugins.setState({ items: [plugin] });
  usePluginSecurity.setState((state) => ({
    state: { ...state.state, grants: { [plugin.id]: plugin.permissions } },
  }));
  expect(
    await runEditorPlugin(
      { id: plugin.id, command: "highlight", title: "Highlight" },
      editorDocument("review")!,
    ),
  ).toBe(false);
  expect(api.pluginRun).not.toHaveBeenCalled();
  expect(editorDocument("review")?.content).toBe("const original = 1;");
});
it("legitimate syntax+format declaration remains writable", async () => {
  usePlugins.setState({ items: [{ ...writable }] });
  usePluginSecurity.setState((state) => ({
    state: { ...state.state, grants: { formatter: writable.permissions } },
  }));
  expect(
    await runEditorPlugin(
      { id: "formatter", command: "format", title: "Format" },
      editorDocument("review")!,
    ),
  ).toBe(true);
  expect(editorDocument("review")?.content).toBe("OVERWRITTEN WITHOUT editor.write");
  expect(shortcutCommands([writable]).some((item) => item.plugin?.command === "format")).toBe(true);
});
it("does not apply an in-flight result after editor.write is revoked", async () => {
  usePlugins.setState({ items: [{ ...writable }] });
  usePluginSecurity.setState((state) => ({
    state: { ...state.state, grants: { formatter: writable.permissions } },
  }));
  const pending = deferred<unknown>();
  vi.mocked(api.pluginRun).mockReturnValue(pending.promise);
  const operation = runEditorPlugin(
    { id: "formatter", command: "format", title: "Format" },
    editorDocument("review")!,
  );
  await vi.waitFor(() => expect(api.pluginRun).toHaveBeenCalledOnce());
  usePluginSecurity.setState((state) => ({
    state: { ...state.state, grants: { formatter: ["editor.read"] } },
  }));
  pending.resolve({ text: "MUST NOT APPLY" });
  expect(await operation).toBe(false);
  expect(editorDocument("review")?.content).toBe("const original = 1;");
});
it("does not apply an in-flight result after declaration changes to syntax-only", async () => {
  usePlugins.setState({ items: [{ ...writable }] });
  usePluginSecurity.setState((state) => ({
    state: { ...state.state, grants: { formatter: writable.permissions } },
  }));
  const pending = deferred<unknown>();
  vi.mocked(api.pluginRun).mockReturnValue(pending.promise);
  const operation = runEditorPlugin(
    { id: "formatter", command: "format", title: "Format" },
    editorDocument("review")!,
  );
  await vi.waitFor(() => expect(api.pluginRun).toHaveBeenCalledOnce());
  usePlugins.setState({
    items: [
      {
        ...writable,
        commands: [{ id: "format", title: "Format", editor: { extensions: ["js"], syntax: true } }],
      },
    ],
  });
  pending.resolve({ text: "MUST NOT APPLY" });
  expect(await operation).toBe(false);
  expect(editorDocument("review")?.content).toBe("const original = 1;");
});
it("legacy read-write editor command remains writable", async () => {
  const legacy = {
    ...writable,
    commands: [{ id: "legacy", title: "Legacy", editor: { extensions: ["js"] } }],
  } as PluginInfo;
  usePlugins.setState({ items: [legacy] });
  usePluginSecurity.setState((state) => ({
    state: { ...state.state, grants: { formatter: legacy.permissions } },
  }));
  expect(
    await runEditorPlugin(
      { id: "formatter", command: "legacy", title: "Legacy" },
      editorDocument("review")!,
    ),
  ).toBe(true);
  expect(editorDocument("review")?.content).toBe("OVERWRITTEN WITHOUT editor.write");
});
