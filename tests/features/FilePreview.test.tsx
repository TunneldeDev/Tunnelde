import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "@/i18n/i18n";
import { FilePreview } from "@/features/sftp/FilePreview";
import { useFilePreview } from "@/store/filePreview";
import { api } from "@/lib/api/ipc";

vi.mock("@/lib/api/ipc", () => ({
  api: { searchPreviewLocal: vi.fn(), sftpReadText: vi.fn(), openLocalPath: vi.fn() },
}));

beforeEach(() => {
  useFilePreview.setState({ file: null });
  vi.clearAllMocks();
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
});
