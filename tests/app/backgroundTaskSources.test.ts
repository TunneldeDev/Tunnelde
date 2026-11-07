import { afterEach, expect, it, vi } from "vitest";
import i18n from "@/i18n/i18n";
import { api } from "@/lib/api/ipc";
import { registerBackgroundTaskSources } from "@/app/backgroundTaskSources";
import { useEditorCleanup } from "@/store/editorCleanup";
import { useBackgroundTasks } from "@/lib/tasks/background";

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  dispose = undefined;
  useEditorCleanup.setState({ items: [] });
});

it("distinguishes local cleanup paths from remote hosts and retries the native task", async () => {
  await i18n.changeLanguage("en-US");
  const local = {
    id: "local-save",
    source: "local" as const,
    path: "C:/notes/doc.txt",
    directory: "C:/notes/.tunnelde-save-local-save",
    address: "",
    updatedAt: 1,
    running: false,
    error: null,
  };
  const remote = {
    ...local,
    id: "remote-save",
    source: "remote" as const,
    address: "user@server",
    directory: "/home/user/.tunnelde-save-remote-save",
  };
  useEditorCleanup.setState({ items: [local, remote] });
  vi.spyOn(api, "editorCleanupRetry").mockResolvedValue(undefined);
  vi.spyOn(api, "editorCleanupList").mockResolvedValue([remote]);
  dispose = registerBackgroundTaskSources();
  const tasks = useBackgroundTasks.getState().items.filter((t) => t.source === "editor-cleanup");
  expect(tasks).toHaveLength(2);
  expect(tasks[0]?.message).toBe(`Local · ${local.directory}`);
  expect(tasks[1]?.message).toBe(`user@server · ${remote.directory}`);
  expect(tasks[0]?.title).toBe("Clean up editor staging");
  await tasks[0]?.actions?.find((a) => a.id === "retry")?.run();
  expect(api.editorCleanupRetry).toHaveBeenCalledWith("local-save");
  expect(useBackgroundTasks.getState().items.some((t) => t.id === "local-save")).toBe(false);
  await i18n.changeLanguage("zh-CN");
  expect(useBackgroundTasks.getState().items.find((t) => t.id === "remote-save")?.title).toBe(
    "清理编辑暂存文件",
  );
});
