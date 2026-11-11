import { beforeEach, describe, expect, it, vi } from "vitest";

import { api } from "@/lib/api/ipc";
import { editorDocument, undoEditorEdit, useEditors } from "@/store/editors";
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
  vi.spyOn(api, "sftpReadText").mockResolvedValue({ content: "original", size: 8 });
  vi.spyOn(api, "sftpWriteText").mockResolvedValue(undefined);
});

describe("editor requests", () => {
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
    expect(await state().resolveConflict(review, "external edit", "replace")).toBe(true);
    expect(api.sftpWriteText).toHaveBeenLastCalledWith("s1", "/a.txt", "my draft", "external edit");
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
    expect(await state().resolveConflict(stale, "external", "replace")).toBe(false);
    expect(api.sftpWriteText).not.toHaveBeenCalled();
    expect(state().entries[id]?.content).toBe("newer draft");
    expect(await state().resolveConflict(editorDocument(id)!, "external", "reload")).toBe(true);
    expect(state().isDirty(id)).toBe(false);
    undoEditorEdit(id, false);
    expect(state().entries[id]).toMatchObject({ content: "newer draft", baseline: "external" });
    expect(state().isDirty(id)).toBe(true);
  });

  it("keeps the draft dirty after a failed reviewed replacement", async () => {
    await state().open(id, "s1", "/a.txt");
    state().change(id, "my draft");
    vi.mocked(api.sftpWriteText).mockRejectedValueOnce({
      code: "ssh",
      message: "sftp.reconnectRequired",
    });
    expect(await state().resolveConflict(editorDocument(id)!, "external", "replace")).toBe(false);
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
    vi.spyOn(api, "localReadText").mockResolvedValue({ content: "original", size: 8 });
    const write = vi.spyOn(api, "localWriteText").mockResolvedValue(undefined);
    await state().open(localId, null, path);
    state().change(localId, "draft");
    state().markDisconnected("s1");
    expect(await state().save(localId)).toBe(true);
    expect(write).toHaveBeenCalledWith(path, "draft", "original");
    state().change(localId, "new draft");
    write.mockRejectedValueOnce({ code: "validation", message: "editor.localFileChanged" });
    expect(await state().save(localId)).toBe(false);
    expect(state().entries[localId]).toMatchObject({ content: "new draft", baseline: "draft" });
    expect(state().isDirty(localId)).toBe(true);
    expect(api.sftpWriteText).not.toHaveBeenCalled();
  });

  it("cannot save a file when opening rejected its text encoding", async () => {
    vi.mocked(api.sftpReadText).mockRejectedValueOnce({
      code: "ssh",
      message: "sftp.unsupportedEncoding",
    });
    await state().open(id, "s1", "/a.txt");
    expect(state().entries[id]?.loading).toBe(false);
    expect(state().entries[id]?.error).toBe("Only UTF-8 text files can be edited");
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
    expect(api.sftpWriteText).toHaveBeenCalledWith("s1", "/a.txt", "first", "original");
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
    );
  });

  it("lets the latest reconnect intent win and suppresses older failures", async () => {
    await state().open(id, "s1", "/a.txt");
    state().change(id, "local draft");
    state().markDisconnected("s1");
    const older = deferred<{ content: string; size: number }>();
    const newer = deferred<{ content: string; size: number }>();
    vi.mocked(api.sftpReadText)
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(newer.promise);
    const first = state().reconnect(id, "s2");
    const second = state().reconnect(id, "s3");
    expect(await first).toBe("failed");
    newer.resolve({ content: "original", size: 8 });
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
