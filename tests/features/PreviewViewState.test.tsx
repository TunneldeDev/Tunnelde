import "@/i18n/i18n";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createPanelViewState, PanelViewStateScope } from "@/lib/panels/viewState";
import { PreviewBody } from "@/features/sftp/preview/PreviewBody";
import { TextContent } from "@/features/sftp/TextPreview";
import { MediaPreview } from "@/features/sftp/MediaPreview";
import type { PreviewFile } from "@/store/filePreview";
const file: PreviewFile = { path: "/readme.md", source: { kind: "local" }, line: 0, column: 0 };
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
it("qualifies Markdown presentation by read attempt, and transports no text in the view capsule", () => {
  const first = createPanelViewState();
  const body = <TextContent file={file} content="confidential source" markdown />;
  const view = render(
    <PanelViewStateScope controller={first}>
      <PreviewBody attemptId="one">{body}</PreviewBody>
    </PanelViewStateScope>,
  );
  fireEvent.click(screen.getByRole("button"));
  expect(screen.getByRole("textbox")).toHaveProperty("value", "confidential source");
  const capsule = first.capture();
  expect(capsule).toMatchObject({
    fields: { "preview:one": { fields: { "text.markdown": false } } },
  });
  expect(JSON.stringify(capsule)).not.toContain("confidential");
  view.unmount();
  const second = createPanelViewState(capsule);
  const destination = render(
    <PanelViewStateScope controller={second}>
      <PreviewBody attemptId="one">{body}</PreviewBody>
    </PanelViewStateScope>,
  );
  expect(screen.getByRole("textbox")).toBeTruthy();
  destination.unmount();
  render(
    <PanelViewStateScope controller={createPanelViewState(capsule)}>
      <PreviewBody attemptId="replacement">{body}</PreviewBody>
    </PanelViewStateScope>,
  );
  expect(screen.queryByRole("textbox")).toBeNull();
});
it("marks text scroll/caret for the common panel restoration without focusing an inert staged body", () => {
  render(
    <div inert>
      <TextContent
        file={{ ...file, line: 2, column: 3 }}
        content={"first\nsecond"}
        markdown={false}
      />
    </div>,
  );
  const field = screen.getByRole("textbox") as HTMLTextAreaElement;
  expect(field.selectionStart).toBe(8);
  expect(field.getAttribute("data-panel-focus")).toBe("preview.text");
  expect(field.getAttribute("data-panel-scroll")).toBe("preview.text");
  expect(document.activeElement).not.toBe(field);
});
it.each(["audio", "video"] as const)(
  "restores %s position and settings after metadata, without auto-playing or leaking a URL",
  (kind) => {
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
    vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
    const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
    const first = createPanelViewState();
    const body = (
      <MediaPreview
        kind={kind}
        url="preview://localhost/private-handle"
        name="sample"
        onError={vi.fn()}
      />
    );
    const view = render(
      <PanelViewStateScope controller={first}>
        <PreviewBody attemptId="media">{body}</PreviewBody>
      </PanelViewStateScope>,
    );
    const player = screen.getByLabelText("sample") as HTMLMediaElement;
    fireEvent.loadedMetadata(player);
    player.currentTime = 42;
    player.volume = 0.3;
    player.muted = true;
    player.playbackRate = 1.5;
    const capsule = first.capture();
    expect(capsule).toMatchObject({
      fields: {
        "preview:media": { fields: { media: { time: 42, volume: 0.3, muted: true, rate: 1.5 } } },
      },
    });
    expect(JSON.stringify(capsule)).not.toContain("private-handle");
    view.unmount();
    const restored = createPanelViewState(capsule);
    render(
      <PanelViewStateScope controller={restored}>
        <PreviewBody attemptId="media">{body}</PreviewBody>
      </PanelViewStateScope>,
    );
    const destination = screen.getByLabelText("sample") as HTMLMediaElement;
    expect(restored.capture()).toEqual(capsule); // Loading does not overwrite the incoming position.
    Object.defineProperty(destination, "duration", { value: 35 });
    fireEvent.loadedMetadata(destination);
    expect(destination.currentTime).toBe(35);
    expect(destination.volume).toBe(0.3);
    expect(destination.muted).toBe(true);
    expect(destination.playbackRate).toBe(1.5);
    expect(play).not.toHaveBeenCalled();
  },
);
