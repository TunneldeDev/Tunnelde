import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/lib/api/ipc";
import { createFileReadResource, readFileText } from "@/lib/files/resources/read";
import { createProviderPreviewResource } from "@/lib/files/resources/preview";
import type { FilePreviewInfo } from "@/lib/api/types";

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (id: string) => `preview://localhost/${id}`,
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const textProvider = { id: "previews:text", renderer: "text" as const };

beforeEach(() => {
  vi.spyOn(api, "filePreviewClose").mockResolvedValue();
});

describe("file read lifetimes", () => {
  it("captures the exact session and path and retains unsettled IPC after cancellation", async () => {
    const read = deferred<{ content: string; size: number }>();
    vi.spyOn(api, "sftpReadText").mockReturnValue(read.promise);
    const source = { kind: "remote" as const, sessionId: "original-session" };
    const resource = createFileReadResource("/a/../document.txt", source);
    source.sessionId = "replacement-session";
    const result = readFileText(resource, "editor");
    expect(api.sftpReadText).toHaveBeenCalledWith("original-session", "/a/../document.txt");
    resource.scope.dispose();
    await expect(result).rejects.toThrow("extension.scope.closed");
    expect(resource.scope.size).toBe(1);
    read.resolve({ content: "late", size: 4 });
    await vi.waitFor(() => expect(resource.scope.size).toBe(0));
  });

  it("releases a native ticket both before registration and after a late open", async () => {
    const open = deferred<FilePreviewInfo>();
    vi.spyOn(api, "filePreviewOpen").mockReturnValue(open.promise);
    const resource = createProviderPreviewResource("/a.txt", { kind: "local" }, textProvider);
    const id = vi.mocked(api.filePreviewOpen).mock.calls[0]![0];
    resource.dispose();
    await expect(resource.ready).rejects.toThrow("extension.scope.closed");
    expect(api.filePreviewClose).toHaveBeenCalledTimes(1);
    open.resolve({ id, renderer: "text", size: 0 });
    await vi.waitFor(() => expect(api.filePreviewClose).toHaveBeenCalledTimes(2));
    expect(api.filePreviewClose).toHaveBeenNthCalledWith(1, id);
    expect(api.filePreviewClose).toHaveBeenNthCalledWith(2, id);
  });

  it.each([
    { id: "foreign-ticket" },
    { renderer: "video" },
    { size: -1 },
    { size: 0.5 },
    { size: Number.NaN },
    { size: Number.MAX_SAFE_INTEGER + 1 },
    { size: 2 * 1024 * 1024 + 1 },
  ])(
    "rejects inconsistent metadata without reading or closing another ticket: %j",
    async (change) => {
      const fetch = vi.spyOn(globalThis, "fetch");
      vi.spyOn(api, "filePreviewOpen").mockImplementation(
        async (id) => ({ id, renderer: "text", size: 1, ...change }) as FilePreviewInfo,
      );
      const resource = createProviderPreviewResource("/a.txt", { kind: "local" }, textProvider);
      await expect(resource.ready).rejects.toMatchObject({ code: "validation" });
      expect(fetch).not.toHaveBeenCalled();
      expect(api.filePreviewClose).toHaveBeenCalledExactlyOnceWith(
        vi.mocked(api.filePreviewOpen).mock.calls[0]![0],
      );
    },
  );

  it.each([new Uint8Array([0xff]), new Uint8Array([0])])(
    "releases a ticket immediately on invalid text bytes %j",
    async (bytes) => {
      vi.spyOn(api, "filePreviewOpen").mockImplementation(async (id) => ({
        id,
        renderer: "text",
        size: bytes.length,
      }));
      vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(bytes, { status: 206 }));
      const resource = createProviderPreviewResource("/a.txt", { kind: "local" }, textProvider);
      await expect(resource.ready).rejects.toBeDefined();
      expect(api.filePreviewClose).toHaveBeenCalledTimes(1);
      resource.dispose();
      expect(api.filePreviewClose).toHaveBeenCalledTimes(1);
    },
  );

  it("releases failed range reads and does not deliver partial text", async () => {
    vi.spyOn(api, "filePreviewOpen").mockImplementation(async (id) => ({
      id,
      renderer: "text",
      size: 5,
    }));
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("bad", { status: 206 }));
    const resource = createProviderPreviewResource("/a.txt", { kind: "local" }, textProvider);
    await expect(resource.ready).rejects.toThrow("Preview file changed during reading");
    expect(api.filePreviewClose).toHaveBeenCalledTimes(1);
  });

  it("decodes UTF-8 split across bounded ranges and retains a successful ticket until disposal", async () => {
    const text = "a".repeat(1024 * 1024 - 1) + "中";
    const bytes = new TextEncoder().encode(text);
    vi.spyOn(api, "filePreviewOpen").mockImplementation(async (id) => ({
      id,
      renderer: "text",
      size: bytes.length,
    }));
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(bytes.slice(0, 1024 * 1024), { status: 206 }))
      .mockResolvedValueOnce(new Response(bytes.slice(1024 * 1024), { status: 206 }));
    const resource = createProviderPreviewResource("/a.txt", { kind: "local" }, textProvider);
    expect((await resource.ready).content).toBe(text);
    expect(fetch.mock.calls.map((call) => call[1]?.headers)).toEqual([
      { Range: "bytes=0-1048575" },
      { Range: "bytes=1048576-1048577" },
    ]);
    expect(api.filePreviewClose).not.toHaveBeenCalled();
    resource.dispose();
    expect(api.filePreviewClose).toHaveBeenCalledTimes(1);
  });

  it("stops fetching subsequent ranges after cancellation even if a fetch ignores abort", async () => {
    vi.spyOn(api, "filePreviewOpen").mockImplementation(async (id) => ({
      id,
      renderer: "text",
      size: 1024 * 1024 + 1,
    }));
    const response = deferred<Response>();
    const fetch = vi.spyOn(globalThis, "fetch").mockReturnValue(response.promise);
    const resource = createProviderPreviewResource("/a.txt", { kind: "local" }, textProvider);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    const signal = fetch.mock.calls[0]![1]!.signal!;
    resource.dispose();
    await expect(resource.ready).rejects.toThrow("extension.scope.closed");
    expect(signal.aborted).toBe(true);
    response.resolve(new Response(new Uint8Array(1024 * 1024), { status: 206 }));
    await new Promise<void>((done) => setTimeout(done, 0));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(api.filePreviewClose).toHaveBeenCalledTimes(1);
  });
});
