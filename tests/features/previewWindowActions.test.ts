import "@/i18n/i18n";
import { afterEach, expect, it, vi } from "vitest";
import { previewOwners, type PreviewOwner } from "@/features/sftp/preview/owner";
import {
  executePreviewWindowAction,
  type PreviewWindowAction,
} from "@/features/sftp/preview/windowActions";
import { usePanelWindows } from "@/store/panelWindows";
import { useWorkspace } from "@/store/workspace";
import type { FilePreviewContext } from "@/lib/extensions/files/preview/context";
const initial = usePanelWindows.getState();
let dispose = () => {};
afterEach(() => {
  dispose();
  usePanelWindows.setState(initial, true);
  vi.restoreAllMocks();
});
function fixture() {
  const lease = { panelId: "filePreview", windowId: "satellite", generation: 3 };
  usePanelWindows.setState({
    available: true,
    snapshot: { windows: [], transfers: [], panels: [lease] },
  });
  const context = {
    snapshot: {
      id: "target",
      attemptId: "attempt",
      revision: "revision",
      renderer: "text",
      source: { kind: "local" },
      path: "/original.txt",
    },
    validate: vi.fn(),
    validateTarget: vi.fn(),
    close: vi.fn(),
    retry: vi.fn(),
    dock: vi.fn(),
    undock: vi.fn(),
    selectProvider: vi.fn(),
  } as unknown as FilePreviewContext;
  const owner = {
    context,
    source: { fail: vi.fn() },
    onReady: vi.fn(),
    onDecodeError: vi.fn(),
  } as unknown as PreviewOwner;
  const slot = previewOwners.mount();
  dispose = slot.dispose;
  slot.publish(owner);
  const request: PreviewWindowAction = {
    kind: "preview",
    id: "target",
    attemptId: "attempt",
    revision: "revision",
    command: { operation: "retry" },
  };
  return { lease, context, owner, request };
}
it("resolves the exact coordinator read, never a renderer callback or a different target", () => {
  const f = fixture();
  executePreviewWindowAction(f.lease, f.request);
  expect(f.context.validate).toHaveBeenCalledOnce();
  expect(f.context.retry).toHaveBeenCalledOnce();
  for (const field of ["id", "attemptId", "revision"] as const)
    expect(() => executePreviewWindowAction(f.lease, { ...f.request, [field]: "old" })).toThrow(
      "changed",
    );
  expect(f.context.retry).toHaveBeenCalledOnce();
});
it("rejects replaced native generations and wrong panels/windows", () => {
  const f = fixture();
  for (const lease of [
    { ...f.lease, generation: 4 },
    { ...f.lease, windowId: "other" },
    { ...f.lease, panelId: "tasks" },
  ])
    expect(() => executePreviewWindowAction(lease, f.request)).toThrow("changed");
  expect(f.context.retry).not.toHaveBeenCalled();
});
it("edits the captured original target and closes it only after editor dispatch", () => {
  const f = fixture();
  const edit = vi.spyOn(useWorkspace.getState(), "openLocalEditor").mockResolvedValue();
  executePreviewWindowAction(f.lease, { ...f.request, command: { operation: "edit" } });
  expect(edit).toHaveBeenCalledWith("/original.txt");
  expect(f.context.close).toHaveBeenCalledOnce();
});
it("decode failure retires the coordinator's own resource; stale failures cannot close a replacement", () => {
  const f = fixture();
  executePreviewWindowAction(f.lease, { ...f.request, command: { operation: "decodeError" } });
  expect(f.owner.source.fail).toHaveBeenCalledOnce();
  expect(f.owner.onDecodeError).toHaveBeenCalledOnce();
  expect(() =>
    executePreviewWindowAction(f.lease, {
      ...f.request,
      revision: "retired",
      command: { operation: "decodeError" },
    }),
  ).toThrow("changed");
  expect(f.owner.source.fail).toHaveBeenCalledOnce();
});
