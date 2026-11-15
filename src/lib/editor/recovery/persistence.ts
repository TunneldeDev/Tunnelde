import { api } from "@/lib/api/ipc";
import { isIpcError } from "@/lib/api/types";
import { useEditors, type EditorEntry } from "@/store/editors";
import { useSettings } from "@/store/settings";
import { useWorkspace } from "@/store/workspace";
import type { EditorDraft } from "./contracts";
import { reportDraftRecoveryFailure } from "./notifications";

let activeFlush: (() => Promise<void>) | undefined;

/** A clean close cannot silently abandon the last debounce interval. */
export async function flushEditorDrafts(): Promise<void> {
  if (!useSettings.getState().settings.editorDraftRecovery) return;
  if (!activeFlush) throw new Error("editor.recoveryFailed");
  await activeFlush();
}

function drafts(entries: Record<string, EditorEntry>): EditorDraft[] {
  return Object.values(entries).flatMap((entry) => {
    if (entry.content === entry.baseline) return [];
    // Never reconstruct remote authority from a stale session ID or host settings.
    // Reject the entire checkpoint instead of silently dropping a legacy draft.
    if (
      entry.loading ||
      entry.baselineLoaded === false ||
      !entry.documentId ||
      (entry.sessionId !== null && !entry.recoveryTarget)
    )
      throw new Error("editor.recoveryIncomplete");
    return [
      {
        id: entry.documentId,
        path: entry.path,
        source: entry.recoveryTarget
          ? { kind: "remote" as const, ...entry.recoveryTarget }
          : { kind: "local" as const },
        baseline: entry.baseline,
        content: entry.content,
      },
    ];
  });
}

/** One ordered writer per WebView. Failed/unreadable recovery never gets replaced. */
export async function startDraftRecovery(
  signal: AbortSignal,
  resumed: boolean,
): Promise<() => void> {
  let initialEnabled = useSettings.getState().settings.editorDraftRecovery;
  let consentChanged = false;
  const stopWatchingConsent = useSettings.subscribe((state) => {
    if (state.settings.editorDraftRecovery !== initialEnabled) {
      initialEnabled = state.settings.editorDraftRecovery;
      consentChanged = true;
    }
  });
  const snapshot = await api.editorDraftsRead().catch((error) => {
    stopWatchingConsent();
    throw error;
  });
  if (signal.aborted) {
    stopWatchingConsent();
    return () => {};
  }
  let revision = snapshot.revision;
  if (!resumed && !consentChanged && useSettings.getState().settings.editorDraftRecovery) {
    for (const draft of snapshot.drafts) useWorkspace.getState().restoreEditorDraft(draft);
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<void> | undefined;
  let pending = false;
  let stopped = false;
  let failure: unknown;
  let previousEnabled = useSettings.getState().settings.editorDraftRecovery;
  let needsRevision = consentChanged;
  let epoch = 0;
  const enabled = () => useSettings.getState().settings.editorDraftRecovery;
  const canWrite = () => enabled() && !useSettings.getState().saving;
  const persist = async () => {
    if (inFlight) return inFlight;
    if (failure) throw failure;
    if (stopped || !canWrite()) return;
    inFlight = (async () => {
      while (pending && !stopped && canWrite()) {
        pending = false;
        if (needsRevision) {
          const readEpoch = epoch;
          const current = await api.editorDraftsRead();
          if (stopped || !canWrite()) return;
          if (readEpoch !== epoch) {
            pending = true;
            continue;
          }
          revision = current.revision;
          needsRevision = false;
        }
        const writeEpoch = epoch;
        try {
          const next = await api.editorDraftsSave(revision, drafts(useEditors.getState().entries));
          if (writeEpoch === epoch) revision = next;
          else {
            needsRevision = true;
            pending = enabled();
          }
        } catch (error) {
          if (writeEpoch === epoch) throw error;
          needsRevision = true;
          pending = enabled();
        }
      }
    })();
    try {
      await inFlight;
    } catch (error) {
      // Preserve the last durable state; do not adopt a new revision and replay.
      const correctable =
        (error instanceof Error && error.message === "editor.recoveryIncomplete") ||
        (isIpcError(error) &&
          error.code === "validation" &&
          error.message === "editor.recoveryInvalid");
      if (!correctable) failure = error;
      throw error;
    } finally {
      inFlight = undefined;
    }
  };
  const schedule = () => {
    if (stopped || failure) return;
    clearTimeout(timer);
    pending = true;
    timer = setTimeout(
      () =>
        void persist().catch((error) => {
          if (!stopped) reportDraftRecoveryFailure(error);
        }),
      400,
    );
  };
  const flush = async () => {
    clearTimeout(timer);
    if (enabled() && useSettings.getState().saving) throw new Error("editor.recoveryBusy");
    pending = true;
    await persist();
    if (enabled() && (pending || useSettings.getState().saving))
      throw new Error("editor.recoveryBusy");
  };
  activeFlush = flush;
  const editorStop = useEditors.subscribe((state, previous) => {
    if (state.entries !== previous.entries && enabled()) schedule();
  });
  const settingsStop = useSettings.subscribe((state) => {
    const enabled = state.settings.editorDraftRecovery;
    if (enabled !== previousEnabled) {
      epoch += 1;
      previousEnabled = enabled;
      needsRevision = true;
      failure = undefined;
    }
    // Wait for opt-in to be durably confirmed before writing file contents.
    if (enabled && !state.saving) schedule();
    else clearTimeout(timer);
  });
  // Transfer observation without a promise-delivery gap: even an off/on
  // interleaved with the read response must retire the old recovery snapshot.
  stopWatchingConsent();
  const stop = () => {
    stopped = true;
    if (activeFlush === flush) activeFlush = undefined;
    clearTimeout(timer);
    editorStop();
    settingsStop();
  };
  signal.addEventListener("abort", stop, { once: true });
  if (enabled()) schedule();
  return () => {
    signal.removeEventListener("abort", stop);
    stop();
  };
}
