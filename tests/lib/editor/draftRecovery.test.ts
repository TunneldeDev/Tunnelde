import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api } from "@/lib/api/ipc";
import { createDefaultSettings } from "@/lib/prefs/defaults";
import { flushEditorDrafts, startDraftRecovery } from "@/lib/editor/recovery/persistence";
import type { EditorDraft } from "@/lib/editor/recovery/contracts";
import { useEditors } from "@/store/editors";
import { useWorkspace, workspaceRecords } from "@/store/workspace";
import { useSettings } from "@/store/settings";
import { useDialogs } from "@/store/dialogs";
import { useToasts, toast } from "@/store/toasts";
import { requestApplicationAction } from "@/lib/session/restart";

const remote: EditorDraft = {
  id: "a440472a-731d-459e-9c0e-9701e29b5a32",
  path: "/srv/config.json",
  source: { kind: "remote", hostId: "original-host", address: "alice@example.test:22" },
  baseline: "original",
  content: "未保存的“修改”\n",
};
let stop: (() => void) | undefined;
const start = async (resumed = false) => {
  stop = await startDraftRecovery(new AbortController().signal, resumed);
};
beforeEach(() => {
  vi.useFakeTimers();
  useToasts.setState({ items: [] });
  useDialogs.getState().close();
  useSettings.setState({
    settings: { ...createDefaultSettings(), editorDraftRecovery: true },
    saving: false,
  });
  useEditors.setState({ entries: {} });
  useWorkspace.setState({
    tabs: [],
    panes: [{ id: "pane-1", tabIds: [], activeId: null }],
    activeId: null,
    activePaneId: "pane-1",
    layout: { kind: "pane", paneId: "pane-1" },
    split: null,
  });
  vi.spyOn(api, "editorDraftsRead").mockResolvedValue({ revision: "checkpoint", drafts: [] });
  vi.spyOn(api, "editorDraftsSave").mockResolvedValue("next");
  vi.spyOn(api, "sftpReadText").mockResolvedValue({ content: "original", size: 8 });
  vi.spyOn(api, "sftpWriteText").mockResolvedValue(undefined);
  vi.spyOn(api, "localWriteText").mockResolvedValue(undefined);
});
afterEach(() => {
  stop?.();
  stop = undefined;
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("restores remote text offline without a connection, file read, file write or missing-host foreign key", async () => {
  vi.mocked(api.editorDraftsRead).mockResolvedValue({ revision: "checkpoint", drafts: [remote] });
  await start();
  const tab = useWorkspace.getState().tabs[0]!;
  expect(useEditors.getState().entries[tab.id]).toMatchObject({
    content: remote.content,
    baseline: "original",
    disconnected: true,
    recovered: true,
  });
  expect(workspaceRecords()[0]?.hostId).toBeNull();
  expect(api.sftpReadText).not.toHaveBeenCalled();
  expect(api.sftpWriteText).not.toHaveBeenCalled();
  expect(api.localWriteText).not.toHaveBeenCalled();
  expect(await useEditors.getState().save(tab.id)).toBe(false);
  expect(
    await useEditors.getState().reconnect(tab.id, "new-session", false, {
      hostId: "original-host",
      address: "mallory@example.test:22",
    }),
  ).toBe("failed");
  expect(api.sftpReadText).not.toHaveBeenCalled();
  expect(
    await useEditors.getState().reconnect(tab.id, "new-session", false, {
      hostId: "original-host",
      address: "alice@example.test:22",
    }),
  ).toBe("ready");
  expect(useEditors.getState().entries[tab.id]?.content).toBe(remote.content);
  expect(api.sftpWriteText).not.toHaveBeenCalled();
});

it("retains the draft and original baseline when the matching destination file has changed", async () => {
  vi.mocked(api.editorDraftsRead).mockResolvedValue({ revision: "checkpoint", drafts: [remote] });
  vi.mocked(api.sftpReadText).mockResolvedValue({ content: "external edit", size: 13 });
  await start();
  const id = useWorkspace.getState().tabs[0]!.id;
  expect(
    await useEditors
      .getState()
      .reconnect(id, "fresh", false, { hostId: "original-host", address: "alice@example.test:22" }),
  ).toBe("conflict");
  expect(useEditors.getState().entries[id]).toMatchObject({
    content: remote.content,
    baseline: "original",
    disconnected: true,
  });
  expect(api.sftpWriteText).not.toHaveBeenCalled();
});

it("flushes the last edit before debounce and removes recovery only after explicit discard", async () => {
  await start();
  useWorkspace
    .getState()
    .restoreEditorDraft({ ...remote, source: { kind: "local" }, path: "C:\\qa\\draft.json" });
  const id = useWorkspace.getState().tabs[0]!.id;
  useEditors.getState().change(id, "last keystroke");
  expect(api.editorDraftsSave).not.toHaveBeenCalled();
  await flushEditorDrafts();
  expect(api.editorDraftsSave).toHaveBeenLastCalledWith("checkpoint", [
    expect.objectContaining({
      content: "last keystroke",
      baseline: "original",
      source: { kind: "local" },
    }),
  ]);
  useEditors.getState().discard(id);
  await flushEditorDrafts();
  expect(api.editorDraftsSave).toHaveBeenLastCalledWith("next", []);
  expect(api.localWriteText).not.toHaveBeenCalled();
});

it("serializes edits arriving during a checkpoint using its returned revision", async () => {
  let finish!: (revision: string) => void;
  vi.mocked(api.editorDraftsSave).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await start();
  useWorkspace.getState().restoreEditorDraft(remote);
  const id = useWorkspace.getState().tabs[0]!.id;
  const flushing = flushEditorDrafts();
  useEditors.getState().change(id, "newer edit");
  finish("confirmed-first");
  await flushing;
  expect(api.editorDraftsSave).toHaveBeenCalledTimes(2);
  expect(api.editorDraftsSave).toHaveBeenLastCalledWith("confirmed-first", [
    expect.objectContaining({ content: "newer edit" }),
  ]);
});

it("preserves a newer native checkpoint and blocks close flush after a stale failure", async () => {
  await start();
  useWorkspace.getState().restoreEditorDraft(remote);
  vi.mocked(api.editorDraftsSave).mockRejectedValueOnce({
    code: "validation",
    message: "editor.recoveryChanged",
  });
  await expect(flushEditorDrafts()).rejects.toMatchObject({ message: "editor.recoveryChanged" });
  useEditors.getState().change(useWorkspace.getState().tabs[0]!.id, "later");
  await vi.advanceTimersByTimeAsync(1000);
  await expect(flushEditorDrafts()).rejects.toMatchObject({ message: "editor.recoveryChanged" });
  expect(api.editorDraftsSave).toHaveBeenCalledTimes(1);
});

it("does not persist without consent or duplicate in-memory tray recovery", async () => {
  useSettings.setState({ settings: createDefaultSettings() });
  vi.mocked(api.editorDraftsRead).mockResolvedValue({ revision: "checkpoint", drafts: [remote] });
  await start();
  expect(useWorkspace.getState().tabs).toHaveLength(0);
  await flushEditorDrafts();
  expect(api.editorDraftsSave).not.toHaveBeenCalled();
  stop?.();
  useSettings.setState({ settings: { ...createDefaultSettings(), editorDraftRecovery: true } });
  await start(true);
  expect(useWorkspace.getState().tabs).toHaveLength(0);
});

it("blocks close rather than omitting a dirty legacy remote draft, then permits explicit discard", async () => {
  await start(true);
  useWorkspace.getState().restoreEditorDraft(remote);
  const id = useWorkspace.getState().tabs[0]!.id;
  useEditors.setState((state) => ({
    entries: { ...state.entries, [id]: { ...state.entries[id]!, recoveryTarget: undefined } },
  }));
  await expect(flushEditorDrafts()).rejects.toThrow("editor.recoveryIncomplete");
  expect(api.editorDraftsSave).not.toHaveBeenCalled();
  expect(useEditors.getState().entries[id]?.content).toBe(remote.content);
  useEditors.getState().discard(id);
  await flushEditorDrafts();
  expect(api.editorDraftsSave).toHaveBeenLastCalledWith("checkpoint", []);
});

it("waits for durable consent and fences an in-flight save across opt-out and opt-in", async () => {
  let finish!: (revision: string) => void;
  vi.mocked(api.editorDraftsSave).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await start();
  useWorkspace.getState().restoreEditorDraft(remote);
  const flushing = flushEditorDrafts();
  useSettings.setState((state) => ({
    settings: { ...state.settings, editorDraftRecovery: false },
    saving: true,
  }));
  useSettings.setState((state) => ({
    settings: { ...state.settings, editorDraftRecovery: true },
  }));
  finish("obsolete-write");
  await expect(flushing).rejects.toThrow("editor.recoveryBusy");
  expect(api.editorDraftsSave).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1000);
  expect(api.editorDraftsSave).toHaveBeenCalledTimes(1);
  vi.mocked(api.editorDraftsRead).mockResolvedValue({ revision: "opt-out-tombstone", drafts: [] });
  useSettings.setState({ saving: false });
  await flushEditorDrafts();
  expect(api.editorDraftsSave).toHaveBeenLastCalledWith("opt-out-tombstone", [remote]);
});

it("re-reads the consent revision if it changes while the checkpoint read is pending", async () => {
  await start();
  useWorkspace.getState().restoreEditorDraft(remote);
  useSettings.setState((state) => ({
    settings: { ...state.settings, editorDraftRecovery: false },
  }));
  useSettings.setState((state) => ({ settings: { ...state.settings, editorDraftRecovery: true } }));
  let finish!: (snapshot: { revision: string; drafts: EditorDraft[] }) => void;
  vi.mocked(api.editorDraftsRead)
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    )
    .mockResolvedValue({ revision: "current-tombstone", drafts: [] });
  const flushing = flushEditorDrafts();
  useSettings.setState((state) => ({
    settings: { ...state.settings, editorDraftRecovery: false },
  }));
  useSettings.setState((state) => ({ settings: { ...state.settings, editorDraftRecovery: true } }));
  finish({ revision: "obsolete-tombstone", drafts: [] });
  await flushing;
  expect(api.editorDraftsSave).toHaveBeenCalledTimes(1);
  expect(api.editorDraftsSave).toHaveBeenLastCalledWith("current-tombstone", [remote]);
});

it("does not replace recovery if initial read fails or startup was cancelled", async () => {
  vi.mocked(api.editorDraftsRead).mockRejectedValueOnce(new Error("unreadable"));
  await expect(start()).rejects.toThrow("unreadable");
  const controller = new AbortController();
  controller.abort();
  vi.mocked(api.editorDraftsRead).mockResolvedValue({ revision: "checkpoint", drafts: [remote] });
  stop = await startDraftRecovery(controller.signal, false);
  await vi.advanceTimersByTimeAsync(1000);
  expect(useWorkspace.getState().tabs).toHaveLength(0);
  expect(api.editorDraftsSave).not.toHaveBeenCalled();
});

it("never restores an obsolete startup read across an explicit opt-out and opt-in", async () => {
  let finish!: (snapshot: { revision: string; drafts: EditorDraft[] }) => void;
  vi.mocked(api.editorDraftsRead).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const starting = start();
  useSettings.setState((state) => ({
    settings: { ...state.settings, editorDraftRecovery: false },
  }));
  useSettings.setState((state) => ({ settings: { ...state.settings, editorDraftRecovery: true } }));
  vi.mocked(api.editorDraftsRead).mockResolvedValue({ revision: "cleared-at-opt-out", drafts: [] });
  finish({ revision: "old-startup", drafts: [remote] });
  await starting;
  expect(useWorkspace.getState().tabs).toHaveLength(0);
  await flushEditorDrafts();
  expect(api.editorDraftsSave).toHaveBeenLastCalledWith("cleared-at-opt-out", []);
});

it("allows a corrected draft after a definite size rejection without replaying an unknown write", async () => {
  await start();
  useWorkspace.getState().restoreEditorDraft(remote);
  vi.mocked(api.editorDraftsSave).mockRejectedValueOnce({
    code: "validation",
    message: "editor.recoveryInvalid",
  });
  await expect(flushEditorDrafts()).rejects.toMatchObject({ message: "editor.recoveryInvalid" });
  useEditors.getState().change(useWorkspace.getState().tabs[0]!.id, "corrected draft");
  await flushEditorDrafts();
  expect(api.editorDraftsSave).toHaveBeenLastCalledWith("checkpoint", [
    expect.objectContaining({ content: "corrected draft" }),
  ]);
});

it("keeps the startup consent fence until the recovery subscription takes ownership", async () => {
  vi.mocked(api.editorDraftsRead).mockResolvedValue({ revision: "old-startup", drafts: [remote] });
  const starting = start();
  // Interleave a completed preference write with the read's promise delivery.
  await Promise.resolve();
  useSettings.setState((state) => ({
    settings: { ...state.settings, editorDraftRecovery: false },
  }));
  useSettings.setState((state) => ({ settings: { ...state.settings, editorDraftRecovery: true } }));
  vi.mocked(api.editorDraftsRead).mockResolvedValue({ revision: "new-tombstone", drafts: [] });
  await starting;
  expect(useWorkspace.getState().tabs).toHaveLength(0);
  await flushEditorDrafts();
  expect(api.editorDraftsSave).toHaveBeenLastCalledWith("new-tombstone", []);
});

it("shows one recovery failure when background save and native Quit share a failed checkpoint", async () => {
  await start();
  useWorkspace.getState().restoreEditorDraft(remote);
  vi.mocked(api.editorDraftsSave).mockRejectedValueOnce({
    code: "validation",
    message: "editor.recoveryChanged",
  });
  await vi.advanceTimersByTimeAsync(400);
  expect(useToasts.getState().items).toHaveLength(1);
  const originalNotice = useToasts.getState().items[0];
  const finish = vi.fn(async () => {});
  requestApplicationAction("quit", finish);
  const dialog = useDialogs.getState().dialog;
  if (dialog.kind !== "confirm") throw Error("Missing quit confirmation");
  await dialog.onConfirm();
  expect(finish).not.toHaveBeenCalled();
  expect(api.editorDraftsSave).toHaveBeenCalledOnce();
  expect(useToasts.getState().items).toEqual([originalNotice]);
  expect(Object.values(useEditors.getState().entries)[0]?.content).toBe(remote.content);
});

it("coalesces a background rejection arriving while native Restart awaits the same write", async () => {
  let reject!: (error: unknown) => void;
  vi.mocked(api.editorDraftsSave).mockImplementationOnce(
    () =>
      new Promise((_, failed) => {
        reject = failed;
      }),
  );
  await start();
  useWorkspace.getState().restoreEditorDraft(remote);
  await vi.advanceTimersByTimeAsync(400);
  const finish = vi.fn(async () => {});
  requestApplicationAction("restart", finish);
  const dialog = useDialogs.getState().dialog;
  if (dialog.kind !== "confirm") throw Error("Missing restart confirmation");
  const confirming = dialog.onConfirm();
  reject({ code: "validation", message: "editor.recoveryChanged" });
  await confirming;
  expect(useToasts.getState().items).toHaveLength(1);
  expect(api.editorDraftsSave).toHaveBeenCalledOnce();
  expect(finish).not.toHaveBeenCalled();
});

it.each(["dismissed", "expired"])(
  "reports a cached checkpoint again after its notice was %s",
  async (removal) => {
    await start();
    useWorkspace.getState().restoreEditorDraft(remote);
    vi.mocked(api.editorDraftsSave).mockRejectedValueOnce(Error("checkpoint failed"));
    await vi.advanceTimersByTimeAsync(400);
    const previous = useToasts.getState().items[0]!;
    if (removal === "dismissed") useToasts.getState().dismiss(previous.id);
    else await vi.advanceTimersByTimeAsync(5000);
    expect(useToasts.getState().items).toHaveLength(0);
    requestApplicationAction(
      "quit",
      vi.fn(async () => {}),
    );
    const dialog = useDialogs.getState().dialog;
    if (dialog.kind !== "confirm") throw Error("Missing quit confirmation");
    await dialog.onConfirm();
    expect(useToasts.getState().items).toHaveLength(1);
    expect(useToasts.getState().items[0]?.id).not.toBe(previous.id);
    expect(api.editorDraftsSave).toHaveBeenCalledOnce();
  },
);

it("keeps independent task and native completion failures visible even with the same error text", async () => {
  await start();
  useWorkspace.getState().restoreEditorDraft(remote);
  const error = Error("checkpoint failed");
  vi.mocked(api.editorDraftsSave).mockRejectedValueOnce(error);
  await vi.advanceTimersByTimeAsync(400);
  toast(error.message, "error");
  useSettings.setState((state) => ({
    settings: { ...state.settings, editorDraftRecovery: false },
  }));
  requestApplicationAction(
    "restart",
    vi.fn(async () => {
      throw error;
    }),
  );
  const dialog = useDialogs.getState().dialog;
  if (dialog.kind !== "confirm") throw Error("Missing restart confirmation");
  await dialog.onConfirm();
  expect(useToasts.getState().items).toHaveLength(3);
});

it("does not merge separate checkpoint failures just because their messages match", async () => {
  await start();
  useWorkspace.getState().restoreEditorDraft(remote);
  vi.mocked(api.editorDraftsSave)
    .mockRejectedValueOnce({ code: "validation", message: "editor.recoveryInvalid" })
    .mockRejectedValueOnce({ code: "validation", message: "editor.recoveryInvalid" });
  await vi.advanceTimersByTimeAsync(400);
  requestApplicationAction(
    "quit",
    vi.fn(async () => {}),
  );
  const dialog = useDialogs.getState().dialog;
  if (dialog.kind !== "confirm") throw Error("Missing quit confirmation");
  await dialog.onConfirm();
  expect(api.editorDraftsSave).toHaveBeenCalledTimes(2);
  expect(useToasts.getState().items).toHaveLength(2);
  expect(useToasts.getState().items[0]?.message).toBe(useToasts.getState().items[1]?.message);
});
