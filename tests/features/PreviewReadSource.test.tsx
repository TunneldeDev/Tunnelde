import "@/i18n/i18n";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api } from "@/lib/api/ipc";
import type { FilePreviewInfo } from "@/lib/api/types";
import type { PreviewFile } from "@/store/filePreview";
import { createPreviewReadSource } from "@/features/sftp/preview/readSource";
import { usePreviewReadOwner } from "@/features/sftp/preview/usePreviewReadSource";
import { ProviderPreview } from "@/features/sftp/ProviderPreview";

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (id: string) => `preview://localhost/${id}`,
}));

const file: PreviewFile = {
  path: "/remote/photo.png",
  source: { kind: "remote", sessionId: "original-ssh" },
  line: 0,
  column: 0,
};
const provider = {
  id: "images:png",
  name: "Images",
  renderer: "image" as const,
  extensions: ["png"],
};
const releases: (() => void)[] = [];
const settle = async () => {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}
beforeEach(() => {
  vi.spyOn(api, "filePreviewClose").mockResolvedValue();
  vi.spyOn(api, "filePreviewOpen").mockImplementation(async (id) => ({
    id,
    renderer: "image",
    size: 12,
  }));
});
afterEach(() => {
  cleanup();
  for (const release of releases.splice(0)) release();
  vi.restoreAllMocks();
});

it("display subscribers never acquire or release I/O; resource owners share one exact ticket", async () => {
  const source = createPreviewReadSource(file, "image", provider);
  const changed = vi.fn();
  const unmountDisplay = source.subscribe(changed);
  expect(api.filePreviewOpen).not.toHaveBeenCalled();
  const first = source.retain(),
    second = source.retain();
  releases.push(first, second);
  await waitFor(() => expect(source.snapshot().status).toBe("ready"));
  expect(api.filePreviewOpen).toHaveBeenCalledExactlyOnceWith(
    expect.any(String),
    provider.id,
    file.path,
    "original-ssh",
  );
  const snapshot = source.snapshot();
  unmountDisplay();
  first();
  expect(source.snapshot()).toBe(snapshot);
  expect(api.filePreviewClose).not.toHaveBeenCalled();
  second();
  second();
  expect(api.filePreviewClose).toHaveBeenCalledExactlyOnceWith(
    vi.mocked(api.filePreviewOpen).mock.calls[0]![0],
  );
});

it("a renderer body can disappear and return without reopening the owner's remote resource", async () => {
  function Owner({ body }: { body: boolean }) {
    const source = usePreviewReadOwner(file, "image", "one-attempt", provider);
    return body ? (
      <ProviderPreview
        file={file}
        provider={provider}
        source={source}
        onReady={() => {}}
        onReadError={() => {}}
        onDecodeError={() => {}}
        onRetry={() => {}}
      />
    ) : null;
  }
  const view = render(<Owner body />);
  const image = await screen.findByRole("img", { name: "photo.png" });
  const url = image.getAttribute("src");
  view.rerender(<Owner body={false} />);
  expect(screen.queryByRole("img")).toBeNull();
  expect(api.filePreviewClose).not.toHaveBeenCalled();
  view.rerender(<Owner body />);
  expect((await screen.findByRole("img", { name: "photo.png" })).getAttribute("src")).toBe(url);
  expect(api.filePreviewOpen).toHaveBeenCalledTimes(1);
  view.unmount();
  expect(api.filePreviewClose).toHaveBeenCalledTimes(1);
});

it("captures the original remote target, independent of later mutable request objects", async () => {
  const request: PreviewFile = { ...file, source: { kind: "remote", sessionId: "captured" } };
  const source = createPreviewReadSource(request, "text");
  vi.spyOn(api, "sftpReadText").mockResolvedValue({
    content: "decoded",
    size: 7,
    encoding: "utf-8",
    bom: false,
  });
  request.path = "/replacement";
  request.source = { kind: "remote", sessionId: "replacement" };
  releases.push(source.retain());
  await waitFor(() => expect(source.snapshot().status).toBe("ready"));
  expect(api.sftpReadText).toHaveBeenCalledExactlyOnceWith("captured", file.path, undefined);
});

it("old late results cannot overwrite a restarted owner or close its new native ticket", async () => {
  const pending = deferred<FilePreviewInfo>();
  vi.mocked(api.filePreviewOpen).mockReturnValueOnce(pending.promise);
  const source = createPreviewReadSource(file, "image", provider);
  const stop = source.retain();
  const oldId = vi.mocked(api.filePreviewOpen).mock.calls[0]![0];
  stop();
  releases.push(source.retain());
  await waitFor(() => expect(source.snapshot().status).toBe("ready"));
  const accepted = source.snapshot();
  pending.resolve({ id: oldId, renderer: "image", size: 999 });
  await settle();
  expect(source.snapshot()).toBe(accepted);
  expect(vi.mocked(api.filePreviewClose).mock.calls.map(([id]) => id)).toEqual([oldId, oldId]);
});

it("decode failure immediately retires the exact resource and is not overwritten by late readiness", async () => {
  const pending = deferred<FilePreviewInfo>();
  vi.mocked(api.filePreviewOpen).mockReturnValueOnce(pending.promise);
  const source = createPreviewReadSource(file, "image", provider);
  releases.push(source.retain());
  source.fail(undefined);
  const failure = source.snapshot();
  expect(failure).toEqual({ status: "error", stage: "decode", cause: undefined });
  pending.resolve({
    id: vi.mocked(api.filePreviewOpen).mock.calls[0]![0],
    renderer: "image",
    size: 12,
  });
  await settle();
  expect(source.snapshot()).toBe(failure);
  expect(api.filePreviewClose).toHaveBeenCalledTimes(2);
});

it("a fresh retry starts a new owner while decode failure cannot retire its replacement", async () => {
  function Owner({ attempt }: { attempt: string }) {
    const source = usePreviewReadOwner(file, "image", attempt, provider);
    return (
      <ProviderPreview
        file={file}
        provider={provider}
        source={source}
        onReady={() => {}}
        onReadError={() => {}}
        onDecodeError={() => {}}
        onRetry={() => {}}
      />
    );
  }
  const view = render(<Owner attempt="first" />);
  const old = await screen.findByRole("img", { name: "photo.png" });
  view.rerender(<Owner attempt="second" />);
  await waitFor(() => expect(api.filePreviewOpen).toHaveBeenCalledTimes(2));
  await act(async () => fireEvent.error(old));
  expect(await screen.findByRole("img", { name: "photo.png" })).toBeTruthy();
  expect(api.filePreviewClose).toHaveBeenCalledTimes(1);
});

it("unavailable binary renderers acquire no file access", () => {
  const source = createPreviewReadSource(file, "image");
  releases.push(source.retain());
  expect(source.snapshot()).toEqual({ status: "unavailable" });
  expect(api.filePreviewOpen).not.toHaveBeenCalled();
});
