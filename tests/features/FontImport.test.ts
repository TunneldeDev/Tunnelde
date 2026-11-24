import { beforeEach, expect, it, vi } from "vitest";
import { mainFontServices } from "@/features/settings/FontSettings";
import { api } from "@/lib/api/ipc";
import { previewFont } from "@/lib/fonts/runtime";

const fixture = vi.hoisted(() => ({
  font: {
    reference: { source: "imported" as const, id: "a".repeat(64) },
    name: "Example",
    monospaced: true,
  },
  dispose: vi.fn(),
}));
vi.mock("@/lib/api/ipc", () => ({
  isTauri: () => false,
  api: { fontsImport: vi.fn(), fontsFinishImport: vi.fn() },
}));
vi.mock("@/lib/fonts/runtime", async (original) => ({
  ...(await original<object>()),
  activateFonts: vi.fn(),
  previewFont: vi.fn(),
}));
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.fontsImport).mockResolvedValue({ token: "stage", font: fixture.font });
  vi.mocked(api.fontsFinishImport).mockResolvedValue(fixture.font);
  vi.mocked(previewFont).mockResolvedValue({
    family: "Preview",
    monospaced: true,
    dispose: fixture.dispose,
  });
});

it("commits only after the WebView decodes the staged font and releases its preview", async () => {
  expect(await mainFontServices.importFile()).toEqual(fixture.font);
  expect(previewFont).toHaveBeenCalledWith(fixture.font.reference, "stage");
  expect(api.fontsFinishImport).toHaveBeenCalledExactlyOnceWith("stage", true, true);
  expect(fixture.dispose).toHaveBeenCalledOnce();
});

it("cancels an undecodable font without publishing it", async () => {
  vi.mocked(previewFont).mockRejectedValue(new Error("decode failed"));
  await expect(mainFontServices.importFile()).rejects.toThrow("decode failed");
  expect(api.fontsFinishImport).toHaveBeenCalledExactlyOnceWith("stage", false);
});

it("cleans a staged font and preview when committing fails", async () => {
  vi.mocked(api.fontsFinishImport).mockRejectedValueOnce(new Error("disk full"));
  await expect(mainFontServices.importFile()).rejects.toThrow("disk full");
  expect(api.fontsFinishImport).toHaveBeenLastCalledWith("stage", false);
  expect(fixture.dispose).toHaveBeenCalledOnce();
});

it("leaves the catalogue alone when the file picker is cancelled", async () => {
  vi.mocked(api.fontsImport).mockResolvedValue(null);
  expect(await mainFontServices.importFile()).toBeNull();
  expect(previewFont).not.toHaveBeenCalled();
  expect(api.fontsFinishImport).not.toHaveBeenCalled();
});
