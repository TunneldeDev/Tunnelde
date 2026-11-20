import "@/i18n/i18n";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createPanelViewState, PanelViewStateScope } from "@/lib/panels/viewState";
import { PreviewRenderer, type PreviewRenderRead } from "@/features/sftp/preview/PreviewRenderer";
import type { PreviewFile } from "@/store/filePreview";
import { api } from "@/lib/api/ipc";
const file: PreviewFile = {
  path: "/scoped-file.txt",
  line: 0,
  column: 0,
  source: { kind: "remote", sessionId: "never-open-from-display" },
};
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
it("renders a complete supplied text model without acquiring any local/remote native resource", () => {
  const readText = vi.spyOn(api, "sftpReadText");
  const open = vi.spyOn(api, "filePreviewOpen");
  const close = vi.spyOn(api, "filePreviewClose");
  const controller = createPanelViewState();
  const ready = vi.fn();
  const content = "large private text ".repeat(90_000);
  const view = render(
    <PanelViewStateScope controller={controller}>
      <PreviewRenderer
        file={file}
        renderer="text"
        read={{ status: "ready", content }}
        onReady={ready}
      />
    </PanelViewStateScope>,
  );
  expect(screen.getByRole("textbox")).toHaveProperty("value", content);
  expect(ready).toHaveBeenCalledOnce();
  expect(JSON.stringify(controller.capture())).not.toContain("private text");
  view.unmount();
  expect(readText).not.toHaveBeenCalled();
  expect(open).not.toHaveBeenCalled();
  expect(close).not.toHaveBeenCalled();
});
it.each<PreviewRenderRead>([{ status: "loading" }, { status: "ready", content: null }])(
  "does not acknowledge a text spinner as a restored view: $status",
  (read) => {
    const controller = createPanelViewState();
    const ready = vi.fn();
    render(
      <PanelViewStateScope controller={controller}>
        <PreviewRenderer file={file} renderer="text" read={read} onReady={ready} />
      </PanelViewStateScope>,
    );
    expect(screen.getByRole("status")).toBeTruthy();
    expect(ready).not.toHaveBeenCalled();
    expect(() => controller.capture()).toThrow();
  },
);
it("accepts genuinely empty text as a decoded body, not as missing content", () => {
  const controller = createPanelViewState();
  const ready = vi.fn();
  render(
    <PanelViewStateScope controller={controller}>
      <PreviewRenderer
        file={file}
        renderer="text"
        read={{ status: "ready", content: "" }}
        onReady={ready}
      />
    </PanelViewStateScope>,
  );
  expect(screen.getByRole("textbox")).toHaveProperty("value", "");
  expect(ready).toHaveBeenCalledOnce();
  expect(() => controller.capture()).not.toThrow();
});
it("acknowledges an image only after its actual load event, using the supplied scoped URL", () => {
  const controller = createPanelViewState();
  const ready = vi.fn();
  render(
    <PanelViewStateScope controller={controller}>
      <PreviewRenderer
        file={{ ...file, path: "/photo.png" }}
        renderer="image"
        read={{ status: "ready", resource: { size: 10, renderer: "image" } }}
        url="preview://localhost/panel-scoped-handle"
        onReady={ready}
      />
    </PanelViewStateScope>,
  );
  expect(() => controller.capture()).toThrow();
  const image = screen.getByRole("img");
  expect(image.getAttribute("src")).toContain("panel-scoped-handle");
  fireEvent.load(image);
  expect(ready).toHaveBeenCalledOnce();
  expect(() => controller.capture()).not.toThrow();
});
it("failed read models reject staging, while preserving a visible retry action", async () => {
  const controller = createPanelViewState();
  const retry = vi.fn();
  render(
    <PanelViewStateScope controller={controller}>
      <PreviewRenderer
        file={file}
        renderer="text"
        read={{ status: "error", message: "read unavailable" }}
        onRetry={retry}
      />
    </PanelViewStateScope>,
  );
  await expect(controller.waitReady(new AbortController().signal)).rejects.toThrow(
    "read unavailable",
  );
  expect(screen.getByRole("alert").textContent).toBe("read unavailable");
  fireEvent.click(screen.getByRole("button"));
  expect(retry).toHaveBeenCalledOnce();
});
