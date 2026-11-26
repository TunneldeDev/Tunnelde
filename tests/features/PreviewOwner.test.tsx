import "@/i18n/i18n";
import { StrictMode } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { usePreviewSession } from "@/features/sftp/preview/usePreviewSession";
import { usePreviewReadOwner } from "@/features/sftp/preview/usePreviewReadSource";
import { usePreviewOwner } from "@/features/sftp/preview/usePreviewOwner";
import { previewOwners } from "@/features/sftp/preview/owner";
import { filePreviewObservation } from "@/lib/files/preview/registry";
import { TextPreview } from "@/features/sftp/TextPreview";
import { useFilePreview, type PreviewFile } from "@/store/filePreview";
import { api } from "@/lib/api/ipc";
const file: PreviewFile = {
  path: "/owner.txt",
  source: { kind: "remote", sessionId: "original-ssh" },
  line: 0,
  column: 0,
};
afterEach(() => {
  cleanup();
  useFilePreview.getState().close();
  vi.restoreAllMocks();
});
it("keeps public preview metadata and the exact remote read above an absent presentation body", async () => {
  vi.spyOn(api, "sftpReadText").mockResolvedValue({ content: "same host-owned text", size: 20 });
  useFilePreview.getState().show(file.path, 0, 0, file.source);
  const target = useFilePreview.getState().file!;
  const id = useFilePreview.getState().id!;
  function Owner({ visible }: { visible: boolean }) {
    const { context, renderer, attemptId, onReady, onReadError } = usePreviewSession(
      target,
      id,
      [],
      "quickLook",
    );
    const source = usePreviewReadOwner(target, renderer, attemptId);
    usePreviewOwner({ context, source, providers: [] });
    return visible ? (
      <TextPreview file={target} source={source} onReady={onReady} onError={onReadError} />
    ) : null;
  }
  const view = render(
    <StrictMode>
      <Owner visible />
    </StrictMode>,
  );
  expect((await screen.findByRole("textbox")).textContent).toBe("same host-owned text");
  const owner = previewOwners.snapshot()!;
  const attempt = owner.context.snapshot.attemptId;
  const readCount = vi.mocked(api.sftpReadText).mock.calls.length;
  view.rerender(
    <StrictMode>
      <Owner visible={false} />
    </StrictMode>,
  );
  expect(screen.queryByRole("textbox")).toBeNull();
  expect(filePreviewObservation().preview?.snapshot).toMatchObject({
    id,
    attemptId: attempt,
    state: "ready",
  });
  expect(previewOwners.snapshot()?.source).toBe(owner.source);
  expect(api.sftpReadText).toHaveBeenCalledTimes(readCount);
  view.rerender(
    <StrictMode>
      <Owner visible />
    </StrictMode>,
  );
  await waitFor(() => expect(screen.getByRole("textbox").textContent).toBe("same host-owned text"));
  expect(api.sftpReadText).toHaveBeenCalledTimes(readCount);
  view.unmount();
  expect(filePreviewObservation().preview).toBeNull();
  expect(previewOwners.snapshot()).toBeNull();
});
