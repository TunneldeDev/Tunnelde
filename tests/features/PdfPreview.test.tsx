import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n/i18n";
import PdfPreview from "@/features/sftp/PdfPreview";

const { getDocument, document, loading, page } = vi.hoisted(() => {
  const page = {
    getViewport: ({ scale }: { scale: number }) => ({ width: 600 * scale, height: 800 * scale }),
    render: vi.fn(() => ({ promise: Promise.resolve(), cancel: vi.fn() })),
    cleanup: vi.fn(),
  };
  const document = { numPages: 3, getPage: vi.fn(async () => page) };
  const loading = {
    promise: Promise.resolve(document),
    destroy: vi.fn(),
    onPassword: null as null | (() => void),
  };
  return { getDocument: vi.fn(() => loading), document, loading, page };
});
vi.mock("pdfjs-dist/legacy/build/pdf.mjs", () => ({
  GlobalWorkerOptions: {},
  PDFDataRangeTransport: class {},
  getDocument,
}));

beforeEach(async () => {
  vi.clearAllMocks();
  await i18n.changeLanguage("en-US");
});

describe("PDF preview continuity", () => {
  it("notifies the ticket owner when document decoding fails", async () => {
    const error = new Error("Invalid PDF");
    getDocument.mockReturnValueOnce({ ...loading, promise: Promise.reject(error) });
    const onError = vi.fn();
    render(<PdfPreview url="preview://localhost/invalid" size={1000} onError={onError} />);
    await waitFor(() => expect(onError).toHaveBeenCalledExactlyOnceWith(error));
  });

  it("keeps the document, current page and zoom when translating the controls", async () => {
    const view = render(<PdfPreview url="preview://localhost/document" size={1000} />);
    await waitFor(() => expect(page.render).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    await waitFor(() => expect(document.getPage).toHaveBeenLastCalledWith(2));
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    await waitFor(() => expect(page.render).toHaveBeenCalledTimes(3));
    const canvas = screen.getByRole("img");
    const width = (canvas as HTMLCanvasElement).width;
    await act(async () => {
      await i18n.changeLanguage("zh-CN");
    });
    expect(screen.getByRole("button", { name: i18n.t("preview.nextPage") })).toBeTruthy();
    expect(screen.getByRole("img")).toBe(canvas);
    expect((canvas as HTMLCanvasElement).width).toBe(width);
    expect(screen.getByText("125%")).toBeTruthy();
    expect(document.getPage).toHaveBeenLastCalledWith(2);
    expect(page.render).toHaveBeenCalledTimes(3);
    expect(getDocument).toHaveBeenCalledTimes(1);
    expect(loading.destroy).not.toHaveBeenCalled();
    view.unmount();
    expect(loading.destroy).toHaveBeenCalledTimes(1);
  });

  it("translates the password error without destroying and opening another document", async () => {
    let reject!: (error: Error) => void;
    const passwordLoading = {
      promise: new Promise<typeof document>((_resolve, fail) => {
        reject = fail;
      }),
      destroy: vi.fn(() => reject(new Error("Worker was destroyed"))),
      onPassword: null as null | (() => void),
    };
    getDocument.mockReturnValueOnce(passwordLoading);
    render(<PdfPreview url="preview://localhost/password" size={1000} />);
    await act(async () => {
      passwordLoading.onPassword!();
    });
    expect(screen.getByRole("alert").textContent).toBe(i18n.t("preview.pdfPassword"));
    await act(async () => {
      await i18n.changeLanguage("zh-CN");
    });
    expect(screen.getByRole("alert").textContent).toBe(i18n.t("preview.pdfPassword"));
    expect(getDocument).toHaveBeenCalledTimes(1);
    expect(passwordLoading.destroy).toHaveBeenCalledTimes(1);
  });
});
