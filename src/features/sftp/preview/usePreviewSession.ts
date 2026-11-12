import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { PluginFilePreview } from "@/lib/api/types";
import type {
  FilePreviewError,
  FilePreviewMetadata,
  FilePreviewState,
} from "@/lib/extensions/contracts/files/preview/data";
import type { FilePreviewContext } from "@/lib/extensions/files/preview/context";
import { previewKind } from "@/lib/files/preview";
import {
  previewPanelOpen,
  useFilePreview,
  type PreviewFile,
  type PreviewPresentation,
} from "@/store/filePreview";

/** Rendering belongs to one target activation and one provider/retry attempt. */
export function usePreviewSession(
  file: PreviewFile,
  id: string,
  providers: readonly (PluginFilePreview & { fingerprint?: string })[],
  presentation: PreviewPresentation,
) {
  const [preferred, setPreferred] = useState("");
  const [retry, setRetry] = useState(0);
  const provider = providers.find((item) => item.id === preferred) ?? providers[0];
  const renderer =
    provider?.renderer ??
    (/\.(md|markdown)$/i.test(file.path) ? "markdown" : previewKind(file.path));
  const available = !!provider || renderer === "text" || renderer === "markdown";
  const attempt = useMemo(
    () => ({
      id: crypto.randomUUID(),
      file,
      providerId: provider?.id,
      fingerprint: provider?.fingerprint,
      renderer,
      retry,
    }),
    [file, provider?.id, provider?.fingerprint, renderer, retry],
  );
  const attemptId = attempt.id;
  const activeAttempt = useRef<string | null>(null);
  const [result, setResult] = useState<{
    attemptId: string;
    state: FilePreviewState;
    errorCode: FilePreviewError | null;
  } | null>(null);
  const state = available
    ? result?.attemptId === attemptId
      ? result.state
      : "loading"
    : "unavailable";
  const errorCode = !available
    ? "rendererUnavailable"
    : result?.attemptId === attemptId
      ? result.errorCode
      : null;
  // Plugin refreshes can replace arrays without changing the actual available renderers.
  const providerKey = JSON.stringify(
    providers.map(({ id, name, renderer }) => ({ id, name, renderer })),
  );
  const choices = useMemo(
    () =>
      Object.freeze(
        (JSON.parse(providerKey) as Pick<PluginFilePreview, "id" | "name" | "renderer">[]).map(
          (item) => Object.freeze(item),
        ),
      ),
    [providerKey],
  );
  const snapshot = useMemo<FilePreviewMetadata>(
    () =>
      Object.freeze({
        id,
        revision: crypto.randomUUID(),
        attemptId,
        source: Object.freeze({ ...file.source }),
        path: file.path,
        line: file.line,
        column: file.column,
        presentation,
        renderer,
        providerId: provider?.id ?? null,
        providerCount: choices.length,
        state,
        errorCode,
      }),
    [id, file, attemptId, renderer, provider?.id, choices, state, errorCode, presentation],
  );
  const committed = useRef<FilePreviewMetadata | null>(null);
  useLayoutEffect(() => {
    committed.current = snapshot;
    activeAttempt.current = attemptId;
    return () => {
      committed.current = null;
      activeAttempt.current = null;
    };
  }, [snapshot, attemptId]);
  const report = useCallback(
    (state: FilePreviewState, errorCode: FilePreviewError | null) => {
      if (activeAttempt.current !== attemptId || useFilePreview.getState().file !== file) return;
      setResult((previous) =>
        previous?.attemptId === attemptId &&
        (previous.state === "error" ||
          (previous.state === state && previous.errorCode === errorCode))
          ? previous
          : { attemptId, state, errorCode },
      );
    },
    [file, attemptId],
  );
  const onReady = useCallback(() => report("ready", null), [report]);
  const onReadError = useCallback(() => report("error", "readFailed"), [report]);
  const onDecodeError = useCallback(() => report("error", "decodeFailed"), [report]);
  // These factories only retain callbacks. Host refs are checked when a caller acts.
  const context: FilePreviewContext = {
    snapshot,
    validateTarget() {
      if (useFilePreview.getState().file !== file || useFilePreview.getState().id !== id)
        throw new Error("plugin.filePreview.changed");
      if (useFilePreview.getState().presentation === "docked" && !previewPanelOpen())
        throw new Error("plugin.filePreview.changed");
    },
    validate() {
      context.validateTarget();
      if (committed.current !== snapshot || useFilePreview.getState().file !== file)
        throw new Error("plugin.filePreview.changed");
    },
    readProviders(request) {
      context.validate();
      const offset = request.offset ?? 0,
        limit = request.limit ?? 16;
      if (request.revision !== snapshot.revision) throw new Error("plugin.filePreview.changed");
      if (
        !Number.isSafeInteger(offset) ||
        offset < 0 ||
        offset > choices.length ||
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > 32
      )
        throw new Error("plugin.filePreview.invalid");
      const items = Object.freeze(choices.slice(offset, offset + limit));
      const end = offset + items.length;
      return {
        schemaVersion: 1,
        id,
        revision: snapshot.revision,
        total: choices.length,
        offset,
        nextOffset: end < choices.length ? end : null,
        items,
      };
    },
    close() {
      context.validate();
      committed.current = null;
      useFilePreview.getState().close();
    },
    dock() {
      context.validate();
      if (presentation === "docked") return;
      committed.current = null;
      useFilePreview.getState().dock();
    },
    undock() {
      context.validate();
      if (presentation === "quickLook") return;
      committed.current = null;
      useFilePreview.getState().undock();
    },
    retry() {
      context.validate();
      if (!available) throw new Error("plugin.filePreview.unavailable");
      committed.current = null;
      activeAttempt.current = null;
      setRetry((value) => value + 1);
    },
    selectProvider(providerId) {
      context.validate();
      if (!choices.some((item) => item.id === providerId))
        throw new Error("plugin.filePreview.invalid");
      committed.current = null;
      activeAttempt.current = null;
      setPreferred(providerId);
      // Selecting the current renderer is an explicit fresh activation too.
      setRetry((value) => value + 1);
    },
  };
  return { context, provider, renderer, available, attemptId, onReady, onReadError, onDecodeError };
}
