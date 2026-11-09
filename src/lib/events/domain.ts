import type { FsSource } from "@/lib/api/types";
import { reportError } from "@/lib/diagnostics";
import { createEventBus, type Handler } from "./bus";

export interface FilesChanged {
  source: FsSource;
  origin: string;
}
interface DomainEvents {
  "tunnelde:history-changed": { hostId?: string };
  "tunnelde:files-changed": FilesChanged;
}

// CustomEvents remain a compatibility boundary for integrations; subscribers share one listener.
const bus = createEventBus<DomainEvents>(
  async (name, receive) => {
    const changed = (event: Event) => {
      const detail: unknown = (event as CustomEvent<unknown>).detail;
      if (name === "tunnelde:history-changed") {
        const hostId = (detail as { hostId?: unknown } | null)?.hostId;
        void receive(typeof hostId === "string" ? { hostId } : {});
      } else {
        const value = detail as Partial<FilesChanged> | null;
        if (
          value &&
          typeof value.origin === "string" &&
          (value.source?.kind === "local" ||
            (value.source?.kind === "remote" && typeof value.source.sessionId === "string"))
        )
          void receive(value);
      }
    };
    window.addEventListener(name, changed);
    return () => window.removeEventListener(name, changed);
  },
  (name, error) => reportError("events.domain", name, error),
);

export const domainEvents = {
  historyChanged(hostId?: string) {
    window.dispatchEvent(new CustomEvent("tunnelde:history-changed", { detail: { hostId } }));
  },
  filesChanged(payload: FilesChanged) {
    window.dispatchEvent(new CustomEvent("tunnelde:files-changed", { detail: payload }));
  },
  onHistory(handler: Handler<DomainEvents["tunnelde:history-changed"]>, signal?: AbortSignal) {
    return bus.on("tunnelde:history-changed", handler, signal);
  },
  onFiles(handler: Handler<FilesChanged>, signal?: AbortSignal) {
    return bus.on("tunnelde:files-changed", handler, signal);
  },
};

if (import.meta.hot) import.meta.hot.dispose(() => bus.dispose());
