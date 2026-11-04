import { afterEach, describe, expect, it, vi } from "vitest";
import {
  matchesPreview,
  previewKind,
  previewProviders,
  readPreviewRange,
} from "@/lib/files/preview";
import { plugin } from "../fixtures/plugins";

afterEach(() => vi.unstubAllGlobals());

describe("preview contributions", () => {
  const provider = {
    id: "image",
    name: "Images",
    renderer: "image" as const,
    extensions: ["png", "tar.gz"],
  };
  it("matches case-insensitive compound extensions and uses stable plugin identities", () => {
    expect(matchesPreview(provider, "/tmp/FILE.PNG")).toBe(true);
    expect(matchesPreview(provider, "C:\\archive.tar.gz")).toBe(true);
    expect(matchesPreview(provider, "/tmp/.png")).toBe(false);
    expect(matchesPreview(provider, "/tmp/png")).toBe(false);
    expect(
      previewProviders([
        { ...plugin, id: "b", filePreviews: [provider] },
        { ...plugin, id: "a", filePreviews: [provider] },
      ]).map((p) => p.id),
    ).toEqual(["a:image", "b:image"]);
    expect(previewKind("test.MP4")).toBe("video");
    expect(previewKind("file.pdf")).toBe("pdf");
  });
  it("reads bounded ranges with cancellation and rejects whole-file or stale responses", async () => {
    const fetch = vi.fn().mockResolvedValue({
      status: 206,
      arrayBuffer: () => Promise.resolve(new Uint8Array([1, 2]).buffer),
    });
    vi.stubGlobal("fetch", fetch);
    const controller = new AbortController();
    expect(await readPreviewRange("preview://localhost/id", 10, 12, controller.signal)).toEqual(
      new Uint8Array([1, 2]),
    );
    expect(fetch).toHaveBeenCalledWith(
      "preview://localhost/id",
      expect.objectContaining({ headers: { Range: "bytes=10-11" }, signal: controller.signal }),
    );
    await expect(readPreviewRange("url", 0, 2_000_000, controller.signal)).rejects.toThrow(
      "Invalid preview range",
    );
    fetch.mockResolvedValueOnce({ status: 200 });
    await expect(readPreviewRange("url", 0, 2, controller.signal)).rejects.toThrow("200");
    fetch.mockResolvedValueOnce({
      status: 206,
      arrayBuffer: () => Promise.resolve(new Uint8Array([1]).buffer),
    });
    await expect(readPreviewRange("url", 0, 2, controller.signal)).rejects.toThrow("changed");
  });
});
