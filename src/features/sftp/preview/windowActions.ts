import { SYNTAX_TOKEN_TYPES } from "@/lib/plugins/syntax";
import { previewSyntaxSource } from "./previewSyntax";
import type { PanelLease } from "@/lib/panels/windowProtocol";
import { usePanelWindows } from "@/store/panelWindows";
import { useSsh } from "@/store/ssh";
import { useWorkspace } from "@/store/workspace";
import { previewOwners } from "./owner";

/** Compact validated tokens keep the complete result within the native 64KiB reply limit. */
export type PreviewSyntaxReply = readonly (readonly [number, number, number])[] | null;

export type PreviewCommand =
  | { operation: "ready" | "decodeError" | "close" | "retry" | "dock" | "undock" | "edit" }
  | { operation: "selectProvider"; providerId: string }
  | { operation: "syntax"; from: number; to: number };
export interface PreviewWindowAction {
  kind: "preview";
  id: string;
  attemptId: string;
  revision: string;
  command: PreviewCommand;
}
/** The native queue has already claimed this exact origin. Resolve again at
 * effect time: a valid lease is NOT authority over a replaced preview target. */
export function executePreviewWindowAction(lease: PanelLease, request: PreviewWindowAction) {
  const windows = usePanelWindows.getState();
  const owner = previewOwners.snapshot();
  const snapshot = owner?.context.snapshot;
  if (
    lease.panelId !== "filePreview" ||
    !windows.snapshot.panels.some(
      (p) =>
        p.panelId === lease.panelId &&
        p.windowId === lease.windowId &&
        p.generation === lease.generation,
    ) ||
    !owner ||
    !snapshot ||
    request.id !== snapshot.id ||
    request.attemptId !== snapshot.attemptId ||
    request.revision !== snapshot.revision
  )
    throw new Error("plugin.filePreview.changed");
  owner.context.validate();
  switch (request.command.operation) {
    case "syntax": {
      const { from, to } = request.command;
      const read = owner.source.snapshot();
      if (
        (snapshot.renderer !== "text" && snapshot.renderer !== "markdown") ||
        read.status !== "ready" ||
        typeof read.value.content !== "string" ||
        !Number.isSafeInteger(from) ||
        !Number.isSafeInteger(to) ||
        from < 0 ||
        to <= from ||
        to > read.value.content.length ||
        to - from > 32768
      )
        throw new Error("plugin.filePreview.changed");
      const stillOwned = () => {
        const current = previewOwners.snapshot();
        if (
          current?.source !== owner.source ||
          current.context.snapshot.attemptId !== snapshot.attemptId ||
          current.context.snapshot.revision !== snapshot.revision ||
          !usePanelWindows
            .getState()
            .snapshot.panels.some(
              (p) =>
                p.panelId === lease.panelId &&
                p.windowId === lease.windowId &&
                p.generation === lease.generation,
            )
        )
          return false;
        try {
          current.context.validate();
          return true;
        } catch {
          return false;
        }
      };
      const syntax = previewSyntaxSource(snapshot.path, owner.source, stillOwned);
      if (!syntax) return null;
      const lifetime = new AbortController();
      return syntax
        .highlight(
          {
            tabId: `preview:${snapshot.attemptId}`,
            documentId: snapshot.attemptId,
            version: 0,
            path: snapshot.path,
            name: snapshot.path.split(/[\\/]/).pop() ?? snapshot.path,
            content: read.value.content,
            dirty: false,
          },
          { from, to, documentId: snapshot.attemptId, version: 0 },
          lifetime.signal,
        )
        .then((tokens) => {
          // A lease and attempt must remain current across the asynchronous provider call.
          if (!stillOwned()) return null;
          // Numeric tuples keep the full validated 128KiB token response under
          // the native reply ceiling, without dropping tokens from dense code.
          const compact: PreviewSyntaxReply =
            tokens?.map((token) => [
              token.start,
              token.end,
              SYNTAX_TOKEN_TYPES.indexOf(token.type),
            ]) ?? null;
          return JSON.stringify(compact).length <= 60_000 ? compact : null;
        });
    }
    case "ready":
      owner.onReady?.();
      break;
    case "decodeError":
      owner.source.fail({ code: "validation", message: "preview.mediaError" });
      owner.onDecodeError?.();
      break;
    case "close":
      owner.context.close();
      break;
    case "retry":
      owner.context.retry();
      break;
    case "dock":
      owner.context.dock();
      break;
    case "undock":
      // Quick Look belongs to main. Until its native return transaction is
      // complete, never hide the source or open a phantom main dialog.
      if (lease.windowId !== "main") throw new Error("panel.window.unsupportedPresentation");
      owner.context.undock();
      break;
    case "selectProvider":
      owner.context.selectProvider(request.command.providerId);
      break;
    case "edit": {
      if (snapshot.renderer !== "text" && snapshot.renderer !== "markdown")
        throw new Error("plugin.filePreview.unavailable");
      if (snapshot.source.kind === "local") useWorkspace.getState().openLocalEditor(snapshot.path);
      else {
        const sessionId = snapshot.source.sessionId;
        const session = useSsh.getState().sessions.find((session) => session.id === sessionId);
        if (!session) throw new Error("plugin.filePreview.changed");
        useWorkspace.getState().openEditor(session, snapshot.path);
      }
      owner.context.close();
      break;
    }
  }
  return null;
}
