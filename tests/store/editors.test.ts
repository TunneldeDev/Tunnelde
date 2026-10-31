// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

import { beforeEach, describe, expect, it, vi } from "vitest";

import { api } from "@/lib/api/ipc";
import { useEditors } from "@/store/editors";

const id = "editor:s1:/a.txt";
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const state = () => useEditors.getState();

beforeEach(() => {
  for (const key of Object.keys(state().entries)) state().discard(key);
  vi.spyOn(api, "sftpReadText").mockResolvedValue({ content: "original", size: 8 });
  vi.spyOn(api, "sftpWriteText").mockResolvedValue(undefined);
});

describe("editor requests", () => {
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
    expect(api.sftpWriteText).toHaveBeenCalledWith("s1", "/a.txt", "first");
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
});
