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
        "preview:media": {
          fields: { media: { time: 42, volume: 0.3, muted: true, rate: 1.5, playing: false } },
        },
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
it("freezes a playing source, stages silently and resumes only after commit or rollback", () => {
  const pause = vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(function (
    this: HTMLMediaElement,
  ) {
    Object.defineProperty(this, "paused", { value: true, configurable: true });
  });
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
  const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(async function (
    this: HTMLMediaElement,
  ) {
    Object.defineProperty(this, "paused", { value: false, configurable: true });
  });
  const source = createPanelViewState();
  const tree = (controller: typeof source, active: boolean) => (
    <PanelViewStateScope controller={controller}>
      <PreviewBody attemptId="playback">
        <MediaPreview
          kind="audio"
          url="preview://localhost/private"
          name="playing audio"
          active={active}
          onError={vi.fn()}
        />
      </PreviewBody>
    </PanelViewStateScope>
  );
  const ui = render(tree(source, true));
  const player = screen.getByLabelText("playing audio") as HTMLMediaElement;
  fireEvent.loadedMetadata(player);
  Object.defineProperty(player, "paused", { value: false, configurable: true });
  player.currentTime = 8;
  ui.rerender(tree(source, false));
  expect(pause).toHaveBeenCalled();
  const capsule = source.capture();
  expect(capsule).toMatchObject({
    fields: { "preview:playback": { fields: { media: { time: 8, playing: true } } } },
  });
  ui.rerender(tree(source, true));
  expect(play).toHaveBeenCalledOnce(); // cancelled move returns the same player
  ui.unmount();
  play.mockClear();
  const destination = createPanelViewState(capsule);
  const remote = render(tree(destination, false));
  const staged = screen.getByLabelText("playing audio") as HTMLMediaElement;
  fireEvent.loadedMetadata(staged);
  expect(staged.currentTime).toBe(8);
  expect(play).not.toHaveBeenCalled();
  expect(destination.capture()).toMatchObject({
    fields: { "preview:playback": { fields: { media: { playing: true } } } },
  });
  remote.rerender(tree(destination, true));
  expect(play).toHaveBeenCalledOnce();
});
it("keeps caret, scroll and another control's focus when native metadata recreates the file object", () => {
  const tree = (target: PreviewFile) => (
    <>
      <input aria-label="Provider draft" />
      <TextContent file={target} content="first\nsecond\nthird" markdown={false} />
    </>
  );
  const ui = render(tree(file));
  const text = screen.getByRole("textbox", { name: "Preview file" }) as HTMLTextAreaElement;
  text.setSelectionRange(4, 9);
  text.scrollTop = 37;
  const draft = screen.getByRole("textbox", { name: "Provider draft" });
  draft.focus();
  ui.rerender(tree({ ...file, source: { ...file.source } }));
  expect(document.activeElement).toBe(draft);
  expect(text.selectionStart).toBe(4);
  expect(text.selectionEnd).toBe(9);
  expect(text.scrollTop).toBe(37);
});
