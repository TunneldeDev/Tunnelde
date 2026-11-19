import { afterEach, expect, it, vi } from "vitest";
import { startPanelActions } from "@/app/panelActions";
import { createOutputSource, installOutputSource } from "@/features/output/source";
import type { PanelWindowClient } from "@/lib/panels/windowClient";
import type { PanelActionJob } from "@/lib/panels/windowProtocol";
const mock = vi.hoisted(() => ({
  execute: undefined as unknown as (job: PanelActionJob) => Promise<unknown>,
  dispose: vi.fn(),
  openLatestLog: vi.fn(),
  openLogDir: vi.fn(),
  clipboardWriteText: vi.fn(),
}));
vi.mock("@/lib/panels/windowActions", () => ({
  startWindowActions: (_client: unknown, execute: typeof mock.execute) => {
    mock.execute = execute;
    return { dispose: mock.dispose };
  },
}));
vi.mock("@/lib/api/ipc", () => ({ api: mock, isTauri: () => false }));
const cleanup: (() => void)[] = [];
afterEach(() => {
  cleanup.splice(0).forEach((fn) => fn());
  vi.clearAllMocks();
});
it("runs only closed output actions in the coordinator, without transferring callbacks or re-reading in a satellite", async () => {
  const source = createOutputSource();
  cleanup.push(source.dispose, installOutputSource(source));
  const refresh = vi.spyOn(source, "refresh").mockResolvedValue(undefined),
    clear = vi.spyOn(source, "clear");
  const stop = startPanelActions({ windowId: "main" } as PanelWindowClient, vi.fn());
  cleanup.push(stop);
  const request = (value: PanelActionJob["request"]) =>
    mock.execute({
      id: "job",
      lease: { panelId: "output", windowId: "satellite", generation: 4 },
      request: value,
    });
  for (const operation of ["refresh", "clear", "openLatest", "openDirectory"] as const)
    await request({ kind: "output", operation });
  await request({ kind: "copyOutput", text: "displayed log only" });
  expect(refresh).toHaveBeenCalledOnce();
  expect(clear).toHaveBeenCalledOnce();
  expect(mock.openLatestLog).toHaveBeenCalledOnce();
  expect(mock.openLogDir).toHaveBeenCalledOnce();
  expect(mock.clipboardWriteText).toHaveBeenCalledExactlyOnceWith("displayed log only");
  mock.openLatestLog.mockRejectedValueOnce(new Error("open failed"));
  await expect(request({ kind: "output", operation: "openLatest" })).rejects.toThrow("open failed");
});
