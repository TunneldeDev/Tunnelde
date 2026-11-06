import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { watchCutCompletion } from "@/lib/files/cutCompletion";
import type { PasteClip } from "@/lib/files/dnd";
import { useFileClipboard } from "@/store/fileClipboard";
import { useTransfers, type TransferItem } from "@/store/transfers";

const clip: PasteClip = {
  source: { kind: "local" },
  action: "cut",
  items: [{ path: "D:\\original.txt", name: "original.txt", isDir: false }],
};
const relevant = () => useFileClipboard.getState().clip === clip;
const item = (id: string, status: TransferItem["status"]): TransferItem => ({
  id,
  direction: "transfer",
  name: "original.txt",
  transferred: 0,
  total: 1,
  status,
  error: null,
  updatedAt: 1,
});

beforeEach(() => {
  useTransfers.setState({ items: [] });
  useFileClipboard.setState({ clip });
});
afterEach(() => {
  useFileClipboard.setState({ clip: null });
});

describe("cut completion", () => {
  it("shares and releases one subscription for a large batch", () => {
    const transfers = vi.spyOn(useTransfers, "subscribe");
    const clipboard = vi.spyOn(useFileClipboard, "subscribe");
    const callbacks = Array.from({ length: 100 }, () => vi.fn());
    for (const [index, callback] of callbacks.entries()) {
      watchCutCompletion(String(index), callback, relevant);
    }
    expect(transfers).toHaveBeenCalledTimes(1);
    expect(clipboard).toHaveBeenCalledTimes(1);
    useTransfers.setState({ items: callbacks.map((_, index) => item(String(index), "done")) });
    for (const callback of callbacks) expect(callback).toHaveBeenCalledOnce();
    useTransfers.setState({ items: [] });
    for (const callback of callbacks) expect(callback).toHaveBeenCalledOnce();
    // A new batch starts a new listener after the preceding one was released.
    watchCutCompletion("new", vi.fn(), relevant);
    expect(transfers).toHaveBeenCalledTimes(2);
  });

  it("checks completion that arrived before registration without recursion", () => {
    useTransfers.setState({ items: [item("finished", "done")] });
    const done = vi.fn(() => useFileClipboard.getState().clear());
    watchCutCompletion("finished", done, relevant);
    expect(done).toHaveBeenCalledOnce();
    expect(useFileClipboard.getState().clip).toBeNull();
    useTransfers.setState({ items: [item("finished", "done")] });
    expect(done).toHaveBeenCalledOnce();
  });

  it("retains completion across pause and failure but drops cancelled or removed jobs", () => {
    const done = vi.fn();
    watchCutCompletion("retained", done, relevant);
    for (const status of ["running", "paused", "failed"] as const) {
      useTransfers.setState({ items: [item("retained", status)] });
      expect(done).not.toHaveBeenCalled();
    }
    useTransfers.setState({ items: [item("retained", "done")] });
    expect(done).toHaveBeenCalledOnce();
    for (const status of ["cancelled", "cleanupPending", "removed"] as const) {
      const cancelled = vi.fn();
      watchCutCompletion(status, cancelled, relevant);
      useTransfers.setState({ items: [item(status, status === "removed" ? "running" : status)] });
      useTransfers.setState({ items: [] });
      useTransfers.setState({ items: [item(status, "done")] });
      expect(cancelled).not.toHaveBeenCalled();
    }
  });

  it("cannot complete an old cut after the user replaces their clipboard", () => {
    const done = vi.fn();
    watchCutCompletion("old", done, relevant);
    useFileClipboard.getState().set({ ...clip, action: "copy" });
    useTransfers.setState({ items: [item("old", "done")] });
    expect(done).not.toHaveBeenCalled();
    expect(useFileClipboard.getState().clip?.action).toBe("copy");
  });
});
