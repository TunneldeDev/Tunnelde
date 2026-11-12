import { afterEach, expect, it, vi } from "vitest";
import i18n from "@/i18n/i18n";
import { api } from "@/lib/api/ipc";
import { registerBackgroundTaskSources } from "@/app/backgroundTaskSources";
import { useEditorCleanup } from "@/store/editorCleanup";
import { useBackgroundTasks } from "@/lib/tasks/background";
import { useTransfers } from "@/store/transfers";

let dispose: (() => void) | undefined;
it("unknown legacy mutation offers diagnostics without inventing a query or discard action", async () => {
  useEditorCleanup.setState({
    items: [
      {
        id: "native-legacy-original",
        source: "native",
        action: "inspect",
        address: "user@server",
        path: "/scope/note.txt",
        directory: "",
        updatedAt: 0,
        running: false,
        error: "editor.remoteOutcomeUnknown",
      },
    ],
  });
  const log = vi.spyOn(api, "openLatestLog").mockResolvedValue(undefined);
  const retry = vi.spyOn(api, "editorCleanupRetry").mockResolvedValue(undefined);
  dispose = registerBackgroundTaskSources();
  const task = useBackgroundTasks
    .getState()
    .items.find((item) => item.id === "native-legacy-original");
  expect(task?.status).toBe("attention");
  expect(task?.actions?.map((action) => action.id)).toEqual(["logs"]);
  await task?.actions?.[0]?.run();
  expect(log).toHaveBeenCalledOnce();
  expect(retry).not.toHaveBeenCalled();
});
afterEach(() => {
  dispose?.();
  dispose = undefined;
  useEditorCleanup.setState({ items: [] });
  useTransfers.setState({ items: [] });
});

it.each([
  ["discard", "editor.nativeDiscardUnsent"],
  ["query", "editor.nativeQueryOriginal"],
  ["finish", "editor.nativeFinishRecovery"],
] as const)(
  "native recovery exposes the explicit %s action and a working log link",
  async (action, label) => {
    await i18n.changeLanguage("en-US");
    const pending = {
      id: "native-original",
      source: "native" as const,
      action,
      address: "user@server",
      path: "/scope/note.txt",
      directory: "/scope",
      updatedAt: 0,
      running: false,
      error: "editor.remoteOutcomeUnknown",
    };
    useEditorCleanup.setState({ items: [pending] });
    const retry = vi.spyOn(api, "editorCleanupRetry").mockResolvedValue(undefined);
    vi.spyOn(api, "editorCleanupList").mockResolvedValue([pending]);
    const log = vi.spyOn(api, "openLatestLog").mockResolvedValue(undefined);
    dispose = registerBackgroundTaskSources();
    const task = useBackgroundTasks.getState().items.find((item) => item.id === pending.id);
    expect(task).toMatchObject({
      title: i18n.t("editor.nativeRecoveryTitle"),
      status: "attention",
      execution: "native",
      message: "user@server · /scope/note.txt",
    });
    expect(task?.progress).toBeUndefined();
    expect(task?.actions?.map((item) => item.id)).toEqual(["retry", "logs"]);
    expect(task?.actions?.[0]?.label).toBe(i18n.t(label));
    await task?.actions?.[0]?.run();
    expect(retry).toHaveBeenCalledWith(pending.id);
    await task?.actions?.[1]?.run();
    expect(log).toHaveBeenCalledTimes(1);
  },
);

it("shows retained editor observation as running, then exposes an unresolved outcome after retirement", async () => {
  await i18n.changeLanguage("en-US");
  const pending = {
    id: "observed-save",
    source: "remote" as const,
    path: "/note.txt",
    directory: "/.tunnelde-save-observed",
    address: "user@server",
    updatedAt: 1,
    running: true,
    error: "editor.remoteOutcomeUnknown",
  };
  useEditorCleanup.setState({ items: [pending] });
  dispose = registerBackgroundTaskSources();
  const task = () => useBackgroundTasks.getState().items.find((item) => item.id === pending.id);
  expect(task()).toMatchObject({ title: "Editor file operation in progress", status: "running" });
  expect(task()?.error).toBeUndefined();
  expect(task()?.actions?.find((action) => action.id === "retry")?.disabled).toBe(true);
  useEditorCleanup.setState({ items: [{ ...pending, running: false }] });
  expect(task()?.status).toBe("attention");
  expect(task()?.error).toBe(i18n.t("editor.remoteOutcomeUnknown"));
  expect(task()?.actions?.find((action) => action.id === "retry")?.disabled).toBe(false);
  await i18n.changeLanguage("zh-CN");
  useEditorCleanup.setState({ items: [pending] });
  expect(task()?.title).toBe("正在处理编辑器文件操作");
  expect(task()?.error).toBeUndefined();
});

it("retained directory receipts are attention tasks without fabricated byte progress", async () => {
  await i18n.changeLanguage("en-US");
  useTransfers.setState({
    items: [
      {
        id: "old-dir",
        name: "file",
        direction: "transfer",
        status: "cleanupPending",
        retainedCreation: true,
        retainedSettlement: "unknown",
        transferred: 0,
        total: 0,
        updatedAt: 1,
        error: "sftp.retainedCreationUnknown",
      },
    ],
  });
  dispose = registerBackgroundTaskSources();
  const task = useBackgroundTasks.getState().items.find((task) => task.id === "old-dir");
  expect(task).toMatchObject({
    title: "Temporary directory · file",
    status: "attention",
    execution: "native",
  });
  expect(task?.progress).toBeUndefined();
});

it("keeps a failed recovery store visible alongside operations and offers a read-only reload", async () => {
  await i18n.changeLanguage("en-US");
  useEditorCleanup.setState({
    items: [
      {
        id: "recovery-remote-store",
        source: "diagnostic",
        action: "reload",
        path: "",
        directory: "",
        address: "",
        updatedAt: 0,
        running: false,
        error: "editor.recoveryStoreUnavailable",
      },
    ],
  });
  dispose = registerBackgroundTaskSources();
  const task = useBackgroundTasks
    .getState()
    .items.find((item) => item.id === "recovery-remote-store");
  expect(task?.status).toBe("attention");
  expect(task?.message).toBe("");
  expect(task?.error).toBe(i18n.t("editor.recoveryStoreUnavailable"));
  expect(task?.actions?.map((action) => action.id)).toEqual(["retry", "logs"]);
  expect(task?.actions?.[0]?.label).toBe("Reload recovery records");
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
    error: "Access denied (os error 5)",
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
  expect(tasks[0]?.error).toBe("Access denied (os error 5)");
  await tasks[0]?.actions?.find((a) => a.id === "retry")?.run();
  expect(api.editorCleanupRetry).toHaveBeenCalledWith("local-save");
  expect(useBackgroundTasks.getState().items.some((t) => t.id === "local-save")).toBe(false);
  await i18n.changeLanguage("zh-CN");
  expect(useBackgroundTasks.getState().items.find((t) => t.id === "remote-save")?.title).toBe(
    "清理编辑暂存文件",
  );
});
