import { beforeEach, describe, expect, it, vi } from "vitest";

import { api } from "@/lib/api/ipc";
import {
  beginEditorComposition,
  beginEditorInput,
  consumeEditorSelectionRestore,
  editorDocument,
  editorHistorySnapshot,
  endEditorComposition,
  rememberEditorSelection,
  replaceEditorDocument,
  restoreEditorHistory,
  undoEditorEdit,
  useEditors,
} from "@/store/editors";
import { useToasts } from "@/store/toasts";

const id = "editor:s1:/a.txt";
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
};
const state = () => useEditors.getState();

beforeEach(() => {
  for (const key of Object.keys(state().entries)) state().discard(key);
  vi.spyOn(api, "sftpReadText").mockResolvedValue({
    content: "original",
    size: 8,
    encoding: "utf-8",
    bom: false,
  });
  vi.spyOn(api, "sftpWriteText").mockResolvedValue(undefined);
});

describe("editor requests", () => {
  it("retains a cancelled save draft and reports cancellation as information", async () => {
    useToasts.setState({ items: [] });
    await state().open(id, "s1", "/a.txt");
    state().change(id, "my draft");
    vi.mocked(api.sftpWriteText).mockRejectedValueOnce({
      code: "validation",
      message: "editor.saveCancelled",
    });
    expect(await state().save(id)).toBe(false);
    expect(state().entries[id]).toMatchObject({
      content: "my draft",
      baseline: "original",
      saving: false,
      saveConflict: false,
      saveFailure: "Saving was cancelled. Your draft has been retained.",
    });
    expect(state().isDirty(id)).toBe(true);
    expect(useToasts.getState().items).toMatchObject([
      { variant: "info", message: "Saving was cancelled. Your draft has been retained." },
    ]);
  });

  it("retains a remote draft and baseline on conflict, then uses the reviewed disk as the next baseline", async () => {
    await state().open(id, "s1", "/a.txt");
    state().change(id, "my draft");
    vi.mocked(api.sftpWriteText).mockRejectedValueOnce({
      code: "validation",
      message: "editor.remoteFileChanged",
    });
    expect(await state().save(id)).toBe(false);
    expect(state().entries[id]).toMatchObject({
      content: "my draft",
      baseline: "original",
      saveConflict: true,
      saving: false,
    });
    const review = editorDocument(id)!;
    expect(
      await state().resolveConflict(
        review,
        { content: "external edit", encoding: "utf-8", bom: false },
        "replace",
      ),
    ).toBe(true);
    expect(api.sftpWriteText).toHaveBeenLastCalledWith(
      "s1",
      "/a.txt",
      "my draft",
      "external edit",
      "utf-8",
      false,
      "utf-8",
      false,
    );
    expect(state().entries[id]).toMatchObject({
      content: "my draft",
      baseline: "my draft",
      saveConflict: false,
    });
  });

  it("refuses stale conflict decisions and allows undo after reloading from disk", async () => {
    await state().open(id, "s1", "/a.txt");
    state().change(id, "my draft");
    const stale = editorDocument(id)!;
    state().change(id, "newer draft");
    expect(
      await state().resolveConflict(
        stale,
        { content: "external", encoding: "utf-8", bom: false },
        "replace",
      ),
    ).toBe(false);
    expect(api.sftpWriteText).not.toHaveBeenCalled();
    expect(state().entries[id]?.content).toBe("newer draft");
    expect(
      await state().resolveConflict(
        editorDocument(id)!,
        { content: "external", encoding: "utf-16le", bom: true },
        "reload",
      ),
    ).toBe(true);
    expect(state().isDirty(id)).toBe(false);
    expect(state().entries[id]).toMatchObject({ encoding: "utf-16le", bom: true });
    undoEditorEdit(id, false);
    expect(state().entries[id]).toMatchObject({ content: "newer draft", baseline: "external" });
    expect(state().isDirty(id)).toBe(true);
  });

  it.each([
    { sessionId: null as string | null, write: "localWriteText" as const },
    { sessionId: "s1" as string | null, write: "sftpWriteText" as const },
  ])(
    "replaces equal text into the selected format through $write and retries after failure",
    async ({ sessionId, write }) => {
      const tabId = sessionId === null ? "editor:format-local" : id;
      const read = {
        content: "hello",
        size: 5,
        encoding: "utf-8" as const,
        bom: false,
      };
      if (sessionId === null) vi.spyOn(api, "localReadText").mockResolvedValue(read);
      else vi.mocked(api.sftpReadText).mockResolvedValueOnce(read);
      const writeCall = vi.spyOn(api, write);
      writeCall.mockRejectedValueOnce({
        code: "validation",
        message: "editor.localFileChanged",
      });
      await state().open(tabId, sessionId, sessionId === null ? "/format.txt" : "/a.txt");
      state().change(tabId, "draft");
      const review = editorDocument(tabId)!;
      expect(
        await state().resolveConflict(
          review,
          { content: "draft", encoding: "utf-16le", bom: true },
          "replace",
        ),
      ).toBe(false);
      expect(writeCall).toHaveBeenCalledOnce();
      expect(state().isDirty(tabId)).toBe(true);
      expect(state().entries[tabId]).toMatchObject({
        content: "draft",
        baseline: "draft",
        encoding: "utf-8",
        bom: false,
        baselineEncoding: "utf-16le",
        baselineBom: true,
      });
      vi.mocked(writeCall).mockResolvedValueOnce(undefined);
      expect(await state().save(tabId)).toBe(true);
      expect(writeCall).toHaveBeenCalledTimes(2);
      expect(state().isDirty(tabId)).toBe(false);
      expect(state().entries[tabId]).toMatchObject({
        baselineEncoding: "utf-8",
        baselineBom: false,
      });
    },
  );

  it("keeps a same-text format-only draft dirty through a save failure", async () => {
    vi.spyOn(api, "localReadText").mockResolvedValue({
      content: "original",
      size: 8,
      encoding: "utf-8",
      bom: false,
    });
    vi.spyOn(api, "localWriteText").mockRejectedValueOnce({
      code: "validation",
      message: "editor.localFileChanged",
    });
    await state().open("format-only", null, "/format-only.txt");
    state().change("format-only", "draft");
    const review = editorDocument("format-only")!;
    await state().resolveConflict(
      review,
      { content: "draft", encoding: "utf-16le", bom: true },
      "replace",
    );
    expect(state().entries["format-only"]).toMatchObject({
      content: "draft",
      baseline: "draft",
      encoding: "utf-8",
      baselineEncoding: "utf-16le",
      saveConflict: true,
    });
    expect(state().isDirty("format-only")).toBe(true);
  });

  it("keeps the draft dirty after a failed reviewed replacement", async () => {
    await state().open(id, "s1", "/a.txt");
    state().change(id, "my draft");
    vi.mocked(api.sftpWriteText).mockRejectedValueOnce({
      code: "ssh",
      message: "sftp.reconnectRequired",
    });
    expect(
      await state().resolveConflict(
        editorDocument(id)!,
        { content: "external", encoding: "utf-8", bom: false },
        "replace",
      ),
    ).toBe(false);
    expect(state().entries[id]).toMatchObject({
      content: "my draft",
      baseline: "external",
      saving: false,
    });
    expect(state().isDirty(id)).toBe(true);
  });
  it("opens and saves local documents without an SSH session, preserving drafts on conflict", async () => {
    const localId = "editor-local:C:\\work\\notes.txt";
    const path = "C:\\work\\notes.txt";
    vi.spyOn(api, "localReadText").mockResolvedValue({
      content: "original",
      size: 8,
      encoding: "utf-8",
      bom: false,
    });
    const write = vi.spyOn(api, "localWriteText").mockResolvedValue(undefined);
    await state().open(localId, null, path);
    state().change(localId, "draft");
    state().markDisconnected("s1");
    expect(await state().save(localId)).toBe(true);
    expect(write).toHaveBeenCalledWith(path, "draft", "original", "utf-8", false, "utf-8", false);
    state().change(localId, "new draft");
    write.mockRejectedValueOnce({ code: "validation", message: "editor.localFileChanged" });
    expect(await state().save(localId)).toBe(false);
    expect(state().entries[localId]).toMatchObject({ content: "new draft", baseline: "draft" });
    expect(state().isDirty(localId)).toBe(true);
    expect(api.sftpWriteText).not.toHaveBeenCalled();
  });

  it("reopens a clean document with an explicit encoding and saves using that metadata", async () => {
    await state().open(id, "s1", "/a.txt");
    vi.mocked(api.sftpReadText).mockResolvedValueOnce({
      content: "旧版中文",
      size: 8,
      encoding: "gb18030",
      bom: false,
    });
    expect(await state().reopen(id, "gb18030")).toBe(true);
    expect(api.sftpReadText).toHaveBeenLastCalledWith("s1", "/a.txt", "gb18030");
    expect(state().entries[id]).toMatchObject({
      content: "旧版中文",
      baseline: "旧版中文",
      encoding: "gb18030",
      bom: false,
    });
    state().change(id, "新版中文");
    expect(await state().save(id)).toBe(true);
    expect(state().entries[id]?.encoding).toBe("gb18030");
    expect(state().entries[id]?.bom).toBe(false);
    expect(api.sftpWriteText).toHaveBeenLastCalledWith(
      "s1",
      "/a.txt",
      "新版中文",
      "旧版中文",
      "gb18030",
      false,
      "gb18030",
      false,
    );
  });

  it("does not change encoding while the document has unsaved edits", async () => {
    await state().open(id, "s1", "/a.txt");
    state().change(id, "draft");
    expect(await state().reopen(id, "big5")).toBe(false);
    expect(api.sftpReadText).toHaveBeenCalledTimes(1);
  });

  it("locks editing while reopening and preserves a draft typed after the operation settles", async () => {
    await state().open(id, "s1", "/a.txt");
    const read = deferred<{ content: string; size: number; encoding: "utf-8"; bom: boolean }>();
    vi.mocked(api.sftpReadText).mockReturnValueOnce(read.promise);
    const reopening = state().reopen(id, "gb18030");
    expect(state().entries[id]?.loading).toBe(true);
    state().change(id, "draft during reopen");
    expect(state().entries[id]?.content).toBe("original");
    read.resolve({ content: "重新读取", size: 12, encoding: "utf-8", bom: false });
    expect(await reopening).toBe(true);
    state().change(id, "draft after reopen");
    expect(state().entries[id]?.content).toBe("draft after reopen");
    expect(state().entries[id]?.baseline).toBe("重新读取");
    expect(state().entries[id]?.loading).toBe(false);
  });

  it("cannot save a file when opening rejected its text encoding", async () => {
    vi.mocked(api.sftpReadText).mockRejectedValueOnce({
      code: "ssh",
      message: "sftp.unsupportedEncoding",
    });
    await state().open(id, "s1", "/a.txt");
    expect(state().entries[id]?.loading).toBe(false);
    expect(state().entries[id]?.error).toBe(
      "The file could not be decoded with the selected text encoding",
    );
    state().change(id, "replacement text");
    expect(await state().save(id)).toBe(false);
    expect(api.sftpWriteText).not.toHaveBeenCalled();
  });

  it("keeps text typed during a save dirty and coalesces duplicate saves", async () => {
    await state().open(id, "s1", "/a.txt");
    state().change(id, "first");
    const write = deferred<void>();
    vi.mocked(api.sftpWriteText).mockReturnValue(write.promise);
    const first = state().save(id);
    const repeated = state().save(id);
    expect(first).toBe(repeated);
    state().change(id, "second");
    write.resolve();
    expect(await first).toBe(true);
    expect(api.sftpWriteText).toHaveBeenCalledTimes(1);
    expect(api.sftpWriteText).toHaveBeenCalledWith(
      "s1",
      "/a.txt",
      "first",
      "original",
      "utf-8",
      false,
      "utf-8",
      false,
    );
    expect(state().entries[id]?.baseline).toBe("first");
    expect(state().entries[id]?.content).toBe("second");
    expect(state().isDirty(id)).toBe(true);
  });

  it("ignores a late read after closing and reopening the same path", async () => {
    const read = deferred<{ content: string; size: number }>();
    vi.mocked(api.sftpReadText).mockReturnValueOnce(read.promise);
    const old = state().open(id, "s1", "/a.txt");
    state().discard(id);
    await state().open(id, "s1", "/a.txt");
    state().change(id, "new draft");
    read.resolve({ content: "stale", size: 5 });
    await old;
    expect(state().entries[id]?.content).toBe("new draft");
  });

  it("ignores a late save after closing and reopening", async () => {
    await state().open(id, "s1", "/a.txt");
    state().change(id, "old draft");
    const write = deferred<void>();
    vi.mocked(api.sftpWriteText).mockReturnValue(write.promise);
    const old = state().save(id);
    state().discard(id);
    await state().open(id, "s1", "/a.txt");
    state().change(id, "new draft");
    write.resolve();
    expect(await old).toBe(false);
    expect(state().entries[id]?.baseline).toBe("original");
    expect(state().entries[id]?.content).toBe("new draft");
  });

  it("keeps an explicit encoding after reconnect when the unchanged bytes decode correctly", async () => {
    await state().open(id, "s1", "/a.txt");
    vi.mocked(api.sftpReadText).mockResolvedValueOnce({
      content: "中文",
      size: 4,
      encoding: "big5",
      bom: false,
    });
    expect(await state().reopen(id, "big5")).toBe(true);
    state().change(id, "中文 draft");
    state().markDisconnected("s1");
    vi.mocked(api.sftpReadText).mockResolvedValueOnce({
      content: "中文",
      size: 4,
      encoding: "big5",
      bom: false,
    });
    expect(await state().reconnect(id, "s2")).toBe("ready");
    expect(api.sftpReadText).toHaveBeenLastCalledWith("s2", "/a.txt", "big5");
    expect(state().entries[id]).toMatchObject({
      content: "中文 draft",
      baseline: "中文",
      encoding: "big5",
      baselineEncoding: "big5",
      disconnected: false,
    });
  });

  it("allows a safe explicit retry after initial decoding fails and clears the error", async () => {
    vi.mocked(api.sftpReadText)
      .mockRejectedValueOnce({ code: "validation", message: "sftp.binaryFile" })
      .mockResolvedValueOnce({
        content: "hello",
        size: 10,
        encoding: "utf-16le",
        bom: false,
      });
    await state().open(id, "s1", "/utf16.txt");
    expect(state().entries[id]?.decodeError).toBe(true);
    expect(await state().reopen(id, "utf-16le")).toBe(true);
    expect(api.sftpReadText).toHaveBeenLastCalledWith("s1", "/utf16.txt", "utf-16le");
    expect(state().entries[id]).toMatchObject({
      content: "hello",
      baseline: "hello",
      encoding: "utf-16le",
      baselineLoaded: true,
      error: null,
      decodeError: false,
    });
    state().change(id, "changed");
    expect(await state().save(id)).toBe(true);
  });

  it("clears a decode error after a failed retry and keeps retrying allowed", async () => {
    vi.mocked(api.sftpReadText)
      .mockRejectedValueOnce({ code: "validation", message: "sftp.binaryFile" })
      .mockRejectedValueOnce({ code: "validation", message: "sftp.unsupportedEncoding" })
      .mockResolvedValueOnce({
        content: "hello",
        size: 10,
        encoding: "utf-16le",
        bom: false,
      });
    await state().open(id, "s1", "/utf16.txt");
    expect(await state().reopen(id, "utf-8")).toBe(false);
    expect(state().entries[id]).toMatchObject({ error: expect.any(String), decodeError: true });
    expect(await state().reopen(id, "utf-16le")).toBe(true);
    expect(state().entries[id]).toMatchObject({
      content: "hello",
      error: null,
      decodeError: false,
    });
  });

  it("does not retry unrelated initial read failures", async () => {
    vi.mocked(api.sftpReadText).mockRejectedValueOnce({
      code: "ssh",
      message: "sftp.fileTooLarge",
    });
    await state().open(id, "s1", "/large.txt");
    expect(state().entries[id]?.decodeError).toBe(false);
    expect(await state().reopen(id, "utf-8")).toBe(false);
    expect(api.sftpReadText).toHaveBeenCalledTimes(1);
  });

  it("auto-detects on first reconnect after the initial open was disconnected", async () => {
    const initial = deferred<{ content: string; size: number }>();
    vi.mocked(api.sftpReadText).mockReturnValueOnce(initial.promise);
    const opening = state().open(id, "s1", "/legacy.txt");
    state().markDisconnected("s1");
    await opening;
    expect(state().entries[id]).toMatchObject({
      encoding: "utf-8",
      bom: false,
      baselineLoaded: false,
      disconnected: true,
    });
    vi.mocked(api.sftpReadText).mockResolvedValueOnce({
      content: "中文",
      size: 8,
      encoding: "gb18030",
      bom: true,
    });
    expect(await state().reconnect(id, "s2")).toBe("ready");
    expect(api.sftpReadText).toHaveBeenLastCalledWith("s2", "/legacy.txt", undefined);
    expect(state().entries[id]).toMatchObject({
      content: "中文",
      baseline: "中文",
      encoding: "gb18030",
      bom: true,
      baselineEncoding: "gb18030",
      baselineBom: true,
      baselineLoaded: true,
    });
  });

  it("does not allow edits or saves while an initial decode is unresolved", async () => {
    vi.mocked(api.sftpReadText).mockRejectedValueOnce({
      code: "validation",
      message: "sftp.binaryFile",
    });
    await state().open(id, "s1", "/binary.txt");
    state().change(id, "replacement");
    expect(state().entries[id]?.content).toBe("");
    expect(await state().save(id)).toBe(false);
  });

  it("treats a reconnect format-only change as a conflict unless accepted", async () => {
    await state().open(id, "s1", "/a.txt");
    state().markDisconnected("s1");
    vi.mocked(api.sftpReadText).mockResolvedValue({
      content: "original",
      size: 8,
      encoding: "utf-8",
      bom: true,
    });
    expect(await state().reconnect(id, "s2")).toBe("conflict");
    expect(await state().reconnect(id, "s2", true)).toBe("ready");
    expect(state().entries[id]).toMatchObject({
      baseline: "original",
      baselineEncoding: "utf-8",
      baselineBom: true,
    });
  });

  it("keeps a disconnected draft and requires approval for a changed remote file", async () => {
    await state().open(id, "s1", "/a.txt");
    state().change(id, "local draft");
    state().markDisconnected("s1");
    expect(await state().save(id)).toBe(false);
    vi.mocked(api.sftpReadText).mockResolvedValue({
      content: "remote change",
      size: 13,
    });
    expect(await state().reconnect(id, "s2")).toBe("conflict");
    expect(state().entries[id]?.disconnected).toBe(true);
    expect(state().entries[id]?.content).toBe("local draft");
    expect(await state().reconnect(id, "s2", true)).toBe("ready");
    expect(state().entries[id]?.baseline).toBe("remote change");
    expect(state().entries[id]?.sessionId).toBe("s2");
    expect(api.sftpWriteText).not.toHaveBeenCalled();
  });

  it("allows the reopened document to save while an old write still runs and settles", async () => {
    await state().open(id, "s1", "/a.txt");
    state().change(id, "old draft");
    const oldWrite = deferred<void>();
    const newWrite = deferred<void>();
    vi.mocked(api.sftpWriteText)
      .mockReturnValueOnce(oldWrite.promise)
      .mockReturnValueOnce(newWrite.promise);
    const oldSave = state().save(id);
    // Same tab reuse without discard used to keep the old promise forever.
    await state().open(id, "s2", "/different.txt");
    state().change(id, "new draft");
    const newSave = state().save(id);
    expect(newSave).not.toBe(oldSave);
    expect(api.sftpWriteText).toHaveBeenLastCalledWith(
      "s2",
      "/different.txt",
      "new draft",
      "original",
      "utf-8",
      false,
      "utf-8",
      false,
    );
    oldWrite.resolve();
    expect(await oldSave).toBe(false);
    expect(state().save(id)).toBe(newSave);
    expect(state().entries[id]).toMatchObject({
      saving: true,
      baseline: "original",
      content: "new draft",
    });
    newWrite.resolve();
    expect(await newSave).toBe(true);
    state().change(id, "next draft");
    expect(await state().save(id)).toBe(true);
    expect(api.sftpWriteText).toHaveBeenCalledTimes(3);
  });

  it("does not retain a rejected synchronous save after the failure is fixed", async () => {
    await state().open(id, "s1", "/a.txt");
    state().change(id, "draft");
    vi.mocked(api.sftpWriteText).mockImplementationOnce(() => {
      throw new Error("IPC unavailable");
    });
    expect(await state().save(id)).toBe(false);
    expect(await state().save(id)).toBe(true);
    expect(api.sftpWriteText).toHaveBeenCalledTimes(2);
  });

  it("settles a disconnected initial load without waiting for its old IPC and fills it on reconnect", async () => {
    const oldRead = deferred<{ content: string; size: number }>();
    vi.mocked(api.sftpReadText).mockReturnValueOnce(oldRead.promise);
    const initial = state().open(id, "s1", "/a.txt");
    state().markDisconnected("s1");
    await initial;
    expect(state().entries[id]).toMatchObject({
      loading: false,
      disconnected: true,
      baselineLoaded: false,
    });
    expect(await state().reconnect(id, "s2")).toBe("ready");
    expect(state().entries[id]).toMatchObject({
      content: "original",
      baseline: "original",
      loading: false,
      disconnected: false,
      baselineLoaded: true,
    });
    oldRead.resolve({ content: "stale", size: 5 });
    await new Promise<void>((done) => setTimeout(done, 0));
    expect(state().entries[id]?.content).toBe("original");
  });

  it("preserves a draft made after an interrupted initial read when reconnecting", async () => {
    const read = deferred<{ content: string; size: number }>();
    vi.mocked(api.sftpReadText).mockReturnValueOnce(read.promise);
    const initial = state().open(id, "s1", "/a.txt");
    state().markDisconnected("s1");
    await initial;
    state().change(id, "disconnected draft");
    expect(await state().reconnect(id, "s2")).toBe("ready");
    expect(state().entries[id]).toMatchObject({
      content: "disconnected draft",
      baseline: "original",
      loading: false,
    });
    read.resolve({ content: "late", size: 4 });
    expect(await state().save(id)).toBe(true);
    expect(api.sftpWriteText).toHaveBeenCalledWith(
      "s2",
      "/a.txt",
      "disconnected draft",
      "original",
      "utf-8",
      false,
      "utf-8",
      false,
    );
  });

  it("lets the latest reconnect intent win and suppresses older failures", async () => {
    await state().open(id, "s1", "/a.txt");
    state().change(id, "local draft");
    state().markDisconnected("s1");
    const older = deferred<{ content: string; size: number }>();
    const newer = deferred<{
      content: string;
      size: number;
      encoding: "utf-8";
      bom: boolean;
    }>();
    vi.mocked(api.sftpReadText)
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(newer.promise);
    const first = state().reconnect(id, "s2");
    const second = state().reconnect(id, "s3");
    expect(await first).toBe("failed");
    newer.resolve({ content: "original", size: 8, encoding: "utf-8", bom: false });
    expect(await second).toBe("ready");
    useToasts.setState({ items: [] });
    older.reject(new Error("stale connection failure"));
    await new Promise<void>((done) => setTimeout(done, 0));
    expect(useToasts.getState().items).toHaveLength(0);
    expect(state().entries[id]).toMatchObject({
      sessionId: "s3",
      content: "local draft",
      baseline: "original",
    });
  });
});

describe("editor undo selection history", () => {
  const selection = (
    start: number,
    end = start,
    direction: "forward" | "backward" | "none" = "none",
  ) => ({
    start,
    end,
    direction,
  });

  beforeEach(() => {
    vi.useRealTimers();
  });

  it("restores selection through undo and redo for a mid-document insertion", async () => {
    vi.mocked(api.sftpReadText).mockResolvedValue({
      content: "abcdef",
      size: 6,
      encoding: "utf-8",
      bom: false,
    });
    await state().open(id, "s1", "/a.txt");
    beginEditorInput(id, "insertText", selection(3));
    state().change(id, "abcXdef", selection(4));

    expect(undoEditorEdit(id)).toBe(true);
    const undone = state().entries[id]!;
    expect(undone.content).toBe("abcdef");
    expect(
      consumeEditorSelectionRestore(id, undone.documentId!, undone.version!, undone.content),
    ).toEqual(selection(3));

    expect(undoEditorEdit(id, true)).toBe(true);
    const redone = state().entries[id]!;
    expect(redone.content).toBe("abcXdef");
    expect(
      consumeEditorSelectionRestore(id, redone.documentId!, redone.version!, redone.content),
    ).toEqual(selection(4));
  });

  it("does not coalesce inputs after the caret or selection changes", async () => {
    vi.mocked(api.sftpReadText).mockResolvedValue({
      content: "abcdef",
      size: 6,
      encoding: "utf-8",
      bom: false,
    });
    await state().open(id, "s1", "/a.txt");
    beginEditorInput(id, "insertText", selection(3));
    state().change(id, "abcXdef", selection(4));
    rememberEditorSelection(id, selection(0));
    beginEditorInput(id, "insertText", selection(0));
    state().change(id, "ZabcXdef", selection(1));

    expect(undoEditorEdit(id)).toBe(true);
    expect(state().entries[id]?.content).toBe("abcXdef");
    expect(undoEditorEdit(id)).toBe(true);
    expect(state().entries[id]?.content).toBe("abcdef");
  });

  it("does not coalesce different input types or ranged replacements", async () => {
    vi.mocked(api.sftpReadText).mockResolvedValue({
      content: "abcdef",
      size: 6,
      encoding: "utf-8",
      bom: false,
    });
    await state().open(id, "s1", "/a.txt");
    beginEditorInput(id, "insertText", selection(3));
    state().change(id, "abcXdef", selection(4));
    beginEditorInput(id, "deleteContentBackward", selection(4));
    state().change(id, "abcdef", selection(3));
    beginEditorInput(id, "insertReplacementText", {
      start: 1,
      end: 4,
      direction: "backward",
    });
    state().change(id, "aQef", { start: 2, end: 2, direction: "none" });

    expect(undoEditorEdit(id)).toBe(true);
    const restored = state().entries[id]!;
    expect(restored.content).toBe("abcdef");
    expect(
      consumeEditorSelectionRestore(id, restored.documentId!, restored.version!, restored.content),
    ).toEqual({ start: 1, end: 4, direction: "backward" });
  });

  it("coalesces continuous typing and deletions while retaining the group boundaries", async () => {
    vi.useFakeTimers({ now: 1_000 });
    vi.mocked(api.sftpReadText).mockResolvedValue({
      content: "abcdef",
      size: 6,
      encoding: "utf-8",
      bom: false,
    });
    await state().open(id, "s1", "/a.txt");
    beginEditorInput(id, "insertText", selection(3));
    state().change(id, "abcXdef", selection(4));
    vi.advanceTimersByTime(100);
    beginEditorInput(id, "insertText", selection(4));
    state().change(id, "abcXYdef", selection(5));
    vi.advanceTimersByTime(100);
    beginEditorInput(id, "deleteContentBackward", selection(5));
    state().change(id, "abcXdef", selection(4));

    expect(undoEditorEdit(id)).toBe(true);
    expect(state().entries[id]?.content).toBe("abcXYdef");
    expect(undoEditorEdit(id)).toBe(true);
    expect(state().entries[id]?.content).toBe("abcdef");
  });

  it("records one undo transaction for a long IME composition", async () => {
    vi.useFakeTimers({ now: 2_000 });
    vi.mocked(api.sftpReadText).mockResolvedValue({
      content: "abcdef",
      size: 6,
      encoding: "utf-8",
      bom: false,
    });
    await state().open(id, "s1", "/a.txt");
    beginEditorComposition(id, selection(3));
    state().change(id, "abc拼", selection(4));
    vi.advanceTimersByTime(2_000);
    state().change(id, "abc拼音", selection(5));
    endEditorComposition(id, selection(5));

    expect(undoEditorEdit(id)).toBe(true);
    expect(state().entries[id]?.content).toBe("abcdef");
    expect(undoEditorEdit(id)).toBe(false);
  });

  it("uses a diff-derived caret for legacy string checkpoints instead of falling to EOF", async () => {
    vi.mocked(api.sftpReadText).mockResolvedValue({
      content: "abcXdef",
      size: 7,
      encoding: "utf-8",
      bom: false,
    });
    await state().open(id, "s1", "/a.txt");
    const documentId = state().entries[id]!.documentId!;
    restoreEditorHistory({ [id]: { documentId, undo: ["abcdef"], redo: [] } });
    rememberEditorSelection(id, selection(7));

    expect(undoEditorEdit(id)).toBe(true);
    const restored = state().entries[id]!;
    expect(restored.content).toBe("abcdef");
    expect(
      consumeEditorSelectionRestore(id, restored.documentId!, restored.version!, restored.content),
    ).toEqual(selection(3));
  });

  it("round-trips exact selection snapshots through the in-memory checkpoint", async () => {
    vi.mocked(api.sftpReadText).mockResolvedValue({
      content: "abcdef",
      size: 6,
      encoding: "utf-8",
      bom: false,
    });
    await state().open(id, "s1", "/a.txt");
    beginEditorInput(id, "insertText", { start: 2, end: 4, direction: "backward" });
    state().change(id, "abQef", selection(3));
    const snapshot = editorHistorySnapshot();
    const savedEntry = { ...state().entries[id]! };

    useEditors.setState({ entries: {} });
    restoreEditorHistory();
    useEditors.setState({ entries: { [id]: savedEntry } });
    restoreEditorHistory(snapshot);

    expect(undoEditorEdit(id)).toBe(true);
    const restored = state().entries[id]!;
    expect(restored.content).toBe("abcdef");
    expect(
      consumeEditorSelectionRestore(id, restored.documentId!, restored.version!, restored.content),
    ).toEqual({ start: 2, end: 4, direction: "backward" });
  });

  it("restores the pre-reload selection after an undoable conflict reload", async () => {
    vi.mocked(api.sftpReadText).mockResolvedValue({
      content: "original",
      size: 8,
      encoding: "utf-8",
      bom: false,
    });
    await state().open(id, "s1", "/a.txt");
    state().change(id, "newer draft", { start: 3, end: 8, direction: "backward" });
    rememberEditorSelection(id, { start: 3, end: 8, direction: "backward" });
    expect(
      await state().resolveConflict(
        editorDocument(id)!,
        { content: "external", encoding: "utf-8", bom: false },
        "reload",
      ),
    ).toBe(true);
    expect(state().entries[id]?.content).toBe("external");

    expect(undoEditorEdit(id)).toBe(true);
    const restored = state().entries[id]!;
    expect(restored.content).toBe("newer draft");
    expect(
      consumeEditorSelectionRestore(id, restored.documentId!, restored.version!, restored.content),
    ).toEqual({ start: 3, end: 8, direction: "backward" });
  });

  it("records a plugin document replacement as one operation with a non-EOF caret", async () => {
    vi.mocked(api.sftpReadText).mockResolvedValue({
      content: "abcdef",
      size: 6,
      encoding: "utf-8",
      bom: false,
    });
    await state().open(id, "s1", "/a.txt");
    rememberEditorSelection(id, { start: 2, end: 4, direction: "forward" });
    replaceEditorDocument(editorDocument(id)!, "abFORMATef");
    const replaced = state().entries[id]!;
    expect(
      consumeEditorSelectionRestore(id, replaced.documentId!, replaced.version!, replaced.content),
    ).toEqual({ start: 2, end: 8, direction: "forward" });

    expect(undoEditorEdit(id)).toBe(true);
    const restored = state().entries[id]!;
    expect(restored.content).toBe("abcdef");
    expect(
      consumeEditorSelectionRestore(id, restored.documentId!, restored.version!, restored.content),
    ).toEqual({ start: 2, end: 4, direction: "forward" });
  });

  it("discards malformed checkpoint entries without losing valid history", async () => {
    vi.mocked(api.sftpReadText).mockResolvedValue({
      content: "abcXdef",
      size: 7,
      encoding: "utf-8",
      bom: false,
    });
    await state().open(id, "s1", "/a.txt");
    const documentId = state().entries[id]!.documentId!;
    restoreEditorHistory({
      [id]: {
        documentId,
        undo: [
          "abcdef",
          { content: 42 } as never,
          { content: "bad", selection: { start: -1 } } as never,
        ],
        redo: [],
      },
    });

    expect(undoEditorEdit(id)).toBe(true);
    expect(state().entries[id]?.content).toBe("abcdef");
  });

  it("invalidates redo after a new edit and preserves the 50-item bound", async () => {
    vi.mocked(api.sftpReadText).mockResolvedValue({
      content: "",
      size: 0,
      encoding: "utf-8",
      bom: false,
    });
    await state().open(id, "s1", "/a.txt");
    for (let index = 1; index <= 55; index += 1) {
      replaceEditorDocument(editorDocument(id)!, "x".repeat(index));
    }
    expect(editorHistorySnapshot()[id]?.undo).toHaveLength(50);
    expect(undoEditorEdit(id)).toBe(true);
    state().change(id, "new", selection(3));
    expect(undoEditorEdit(id, true)).toBe(false);
  });
});
