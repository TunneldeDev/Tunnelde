import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n/i18n";
import { FilePreview } from "@/features/sftp/FilePreview";
import { useFilePreview } from "@/store/filePreview";
import { api } from "@/lib/api/ipc";
import { usePlugins } from "@/store/plugins";
import { plugin } from "../fixtures/plugins";
import { useMarketplace } from "@/store/marketplace";
import { useWorkspace } from "@/store/workspace";

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (id: string) => `preview://localhost/${id}`,
}));

vi.mock("@/lib/api/ipc", () => ({
  api: {
    searchPreviewLocal: vi.fn(),
    sftpReadText: vi.fn(),
    openLocalPath: vi.fn(),
    filePreviewOpen: vi.fn(),
    filePreviewClose: vi.fn(),
  },
}));

beforeEach(async () => {
  await i18n.changeLanguage("en-US");
  useFilePreview.setState({ file: null });
  usePlugins.setState({ items: [] });
  vi.clearAllMocks();
  vi.mocked(api.filePreviewClose).mockResolvedValue();
});

describe("file preview", () => {
  it("reads local text without opening an external application and restores focus on close", async () => {
    vi.mocked(api.searchPreviewLocal).mockResolvedValue("hello preview");
    render(
      <>
        <button onClick={() => useFilePreview.getState().show("C:\\notes.txt")}>Preview</button>
        <FilePreview />
      </>,
    );
    const trigger = screen.getByRole("button", { name: "Preview" });
    trigger.focus();
    fireEvent.click(trigger);
    expect((await screen.findByRole("textbox")).getAttribute("readonly")).not.toBeNull();
    expect(api.searchPreviewLocal).toHaveBeenCalledWith("C:\\notes.txt");
    expect(api.openLocalPath).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("opens local text from preview in the built-in editor", async () => {
    const open = vi.fn();
    useWorkspace.setState({ openLocalEditor: open });
    vi.mocked(api.searchPreviewLocal).mockResolvedValue("hello");
    useFilePreview.getState().show("C:\\notes.txt");
    render(<FilePreview />);
    await screen.findByRole("textbox");
    fireEvent.click(screen.getByRole("button", { name: "Edit text" }));
    expect(open).toHaveBeenCalledWith("C:\\notes.txt");
    expect(api.openLocalPath).not.toHaveBeenCalled();
    expect(useFilePreview.getState().file).toBeNull();
  });

  it("reads remote Markdown through the selected session and switches to source", async () => {
    vi.mocked(api.sftpReadText).mockResolvedValue({ content: "# Preview title", size: 15 });
    useFilePreview.getState().show("/srv/readme.md", 0, 0, { kind: "remote", sessionId: "ssh-2" });
    render(<FilePreview />);
    expect(await screen.findByRole("heading", { name: "Preview title" })).toBeTruthy();
    expect(api.sftpReadText).toHaveBeenCalledWith("ssh-2", "/srv/readme.md");
    expect(api.searchPreviewLocal).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Show source" }));
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("# Preview title");
  });

  it("ignores a stale request when another file is selected", async () => {
    let finish!: (value: string) => void;
    vi.mocked(api.searchPreviewLocal)
      .mockReturnValueOnce(
        new Promise((resolve) => {
          finish = resolve;
        }),
      )
      .mockResolvedValueOnce("new content");
    useFilePreview.getState().show("/old.txt");
    render(<FilePreview />);
    act(() => useFilePreview.getState().show("/new.txt"));
    await screen.findByRole("textbox");
    await act(async () => finish("old content"));
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("new content");
  });

  it("captures the selected session and reloads a fresh activation of the same text file", async () => {
    const source = { kind: "remote" as const, sessionId: "selected-session" };
    vi.mocked(api.sftpReadText).mockResolvedValue({ content: "first", size: 5 });
    useFilePreview.getState().show("/same.txt", 0, 0, source);
    source.sessionId = "unselected-session";
    render(<FilePreview />);
    expect(((await screen.findByRole("textbox")) as HTMLTextAreaElement).value).toBe("first");
    expect(api.sftpReadText).toHaveBeenCalledWith("selected-session", "/same.txt");
    let finish!: (value: { content: string; size: number }) => void;
    vi.mocked(api.sftpReadText).mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    act(() =>
      useFilePreview
        .getState()
        .show("/same.txt", 0, 0, { kind: "remote", sessionId: "selected-session" }),
    );
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.getByRole("status")).toBeTruthy();
    await act(async () => finish({ content: "fresh", size: 5 }));
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("fresh");
  });

  it.each([undefined, new Error("First read failed")])(
    "clears a failed builtin read when the same file is opened again (%j)",
    async (cause) => {
      vi.mocked(api.searchPreviewLocal)
        .mockRejectedValueOnce(cause)
        .mockResolvedValueOnce("recovered");
      useFilePreview.getState().show("/same.txt");
      render(<FilePreview />);
      await screen.findByRole("alert");
      act(() => useFilePreview.getState().show("/same.txt"));
      expect(((await screen.findByRole("textbox")) as HTMLTextAreaElement).value).toBe("recovered");
      expect(screen.queryByRole("alert")).toBeNull();
    },
  );

  it("offers preview extensions for binary files without attempting a text read", () => {
    useFilePreview.getState().show("/photo.png");
    render(<FilePreview />);
    fireEvent.click(screen.getByRole("button", { name: "Find preview plugins" }));
    expect(useMarketplace.getState().query).toBe("@tag:preview");
    expect(useFilePreview.getState().file).toBeNull();
    expect(api.searchPreviewLocal).not.toHaveBeenCalled();
  });

  it("opens remote image providers without an editor action and revokes on close", async () => {
    usePlugins.setState({
      items: [
        {
          ...plugin,
          id: "previews",
          runtime: "theme",
          filePreviews: [{ id: "image", name: "Images", renderer: "image", extensions: ["png"] }],
        },
      ],
    });
    vi.mocked(api.filePreviewOpen).mockImplementation(async (id) => ({
      id,
      size: 123,
      renderer: "image",
    }));
    useFilePreview
      .getState()
      .show("/photo.PNG", 0, 0, { kind: "remote", sessionId: "ssh-preview" });
    render(<FilePreview />);
    const image = await screen.findByRole("img", { name: "photo.PNG" });
    expect(image.getAttribute("src")).toMatch(/^preview:\/\/localhost\//);
    expect(api.filePreviewOpen).toHaveBeenCalledWith(
      expect.any(String),
      "previews:image",
      "/photo.PNG",
      "ssh-preview",
    );
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(api.filePreviewClose).toHaveBeenCalledWith(
      vi.mocked(api.filePreviewOpen).mock.calls[0]![0],
    );
    expect(api.sftpReadText).not.toHaveBeenCalled();
  });

  it("revokes late responses after close and reacts to removed providers", async () => {
    usePlugins.setState({
      items: [
        {
          ...plugin,
          filePreviews: [{ id: "image", name: "Images", renderer: "image", extensions: ["png"] }],
        },
      ],
    });
    let finish!: () => void;
    vi.mocked(api.filePreviewOpen).mockImplementation(
      (id) =>
        new Promise((resolve) => {
          finish = () => resolve({ id, size: 12, renderer: "image" });
        }),
    );
    useFilePreview.getState().show("/photo.png");
    render(<FilePreview />);
    act(() => usePlugins.setState({ items: [] }));
    expect(screen.getByRole("button", { name: "Find preview plugins" })).toBeTruthy();
    await act(async () => finish());
    expect(screen.queryByRole("img")).toBeNull();
    expect(api.filePreviewClose).toHaveBeenCalledTimes(2);
  });

  it("retains its remote media ticket when language changes and translates a later playback error", async () => {
    usePlugins.setState({
      items: [
        {
          ...plugin,
          filePreviews: [{ id: "video", name: "Video", renderer: "video", extensions: ["mp4"] }],
        },
      ],
    });
    vi.mocked(api.filePreviewOpen).mockImplementation(async (id) => ({
      id,
      size: 123,
      renderer: "video",
    }));
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
    vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
    useFilePreview.getState().show("/movie.mp4", 0, 0, { kind: "remote", sessionId: "ssh-media" });
    render(<FilePreview />);
    const player = await screen.findByLabelText("movie.mp4");
    const src = player.getAttribute("src");
    await act(async () => {
      await i18n.changeLanguage("zh-CN");
    });
    expect(screen.getByLabelText("movie.mp4")).toBe(player);
    expect(player.getAttribute("src")).toBe(src);
    expect(api.filePreviewOpen).toHaveBeenCalledTimes(1);
    expect(api.filePreviewClose).not.toHaveBeenCalled();
    fireEvent.error(player);
    expect(screen.getByRole("alert").textContent).toBe(i18n.t("preview.mediaError"));
    expect(api.filePreviewClose).toHaveBeenCalledExactlyOnceWith(
      vi.mocked(api.filePreviewOpen).mock.calls[0]![0],
    );
    await act(async () => {
      await i18n.changeLanguage("en-US");
    });
    expect(screen.getByRole("alert").textContent).toBe(i18n.t("preview.mediaError"));
    expect(api.filePreviewOpen).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByLabelText("movie.mp4");
    expect(api.filePreviewOpen).toHaveBeenCalledTimes(2);
  });
});
