import { StrictMode } from "react";
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@/i18n/i18n";
import { MediaPreview } from "@/features/sftp/MediaPreview";

beforeEach(() => {
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("media preview lifecycle", () => {
  it.each(["audio", "video"] as const)(
    "keeps %s playable after StrictMode replay, switches source and releases it on close",
    (kind) => {
      const preview = (url: string) => (
        <StrictMode>
          <MediaPreview kind={kind} url={url} name="sample" onError={() => {}} />
        </StrictMode>
      );
      const view = render(preview("preview://localhost/first"));
      const player = screen.getByLabelText("sample") as HTMLMediaElement;
      expect(player.getAttribute("src")).toBe("preview://localhost/first");
      view.rerender(preview("preview://localhost/second"));
      expect(screen.getByLabelText("sample")).toBe(player);
      expect(player.getAttribute("src")).toBe("preview://localhost/second");
      view.unmount();
      expect(player.hasAttribute("src")).toBe(false);
      expect(player.pause).toHaveBeenCalled();
      expect(player.load).toHaveBeenCalled();
    },
  );

  it("stops the previous player when switching media types without changing the URL", () => {
    const props = { url: "preview://localhost/file", name: "sample", onError: () => {} };
    const view = render(<MediaPreview {...props} kind="audio" />);
    const audio = screen.getByLabelText("sample");
    view.rerender(<MediaPreview {...props} kind="video" />);
    expect(audio.hasAttribute("src")).toBe(false);
    expect(screen.getByLabelText("sample").getAttribute("src")).toBe(props.url);
    view.unmount();
  });
});
