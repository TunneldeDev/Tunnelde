import { beforeEach, expect, it, vi } from "vitest";
import { api } from "@/lib/api/ipc";
import { useEditorCleanup } from "@/store/editorCleanup";

beforeEach(() => {
  useEditorCleanup.setState({ items: [] });
});

it("ignores an older snapshot arriving after a reconnect refresh", async () => {
  let finish!: (items: Awaited<ReturnType<typeof api.editorCleanupList>>) => void;
  vi.spyOn(api, "editorCleanupList")
    .mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    )
    .mockResolvedValueOnce([]);
  const old = useEditorCleanup.getState().hydrate();
  await useEditorCleanup.getState().hydrate();
  finish([
    {
      id: "stale",
      path: "/file",
      directory: "/stage",
      address: "server",
      updatedAt: 0,
      running: false,
      error: null,
    },
  ]);
  await old;
  expect(useEditorCleanup.getState().items).toEqual([]);
});

it("retains a failed cleanup task after retry and refreshes from the native journal", async () => {
  vi.spyOn(api, "editorCleanupRetry").mockRejectedValue({
    code: "validation",
    message: "sftp.reconnectRequired",
  });
  vi.spyOn(api, "editorCleanupList").mockResolvedValue([
    {
      id: "pending",
      path: "/file",
      directory: "/stage",
      address: "server",
      updatedAt: 1,
      running: false,
      error: "sftp.reconnectRequired",
    },
  ]);
  await expect(useEditorCleanup.getState().retry("pending")).rejects.toMatchObject({
    message: "sftp.reconnectRequired",
  });
  expect(useEditorCleanup.getState().items[0]?.id).toBe("pending");
});
