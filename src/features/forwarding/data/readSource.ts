import { createStore } from "zustand/vanilla";
import { connectionPromptHost } from "@/features/connect/prompt";
import { presentError } from "@/lib/api/errors";
import { useHosts } from "@/store/hosts";
import { usePanelWindows } from "@/store/panelWindows";
import { useSsh } from "@/store/ssh";
import { forwardingSavePayload } from "../model/payload";
import type { ForwardInfo } from "../model/contract";
import { forwardingGroupsStore } from "./groups";
import { forwardingStore } from "./store";
import type { ForwardingReadData, ForwardingReadSnapshot } from "./readModel";

function snapshot<T, U>(
  value: { entries: readonly T[] | null; busy: boolean; error: unknown },
  project: (item: T) => U,
): ForwardingReadSnapshot<U> {
  return {
    entries: value.entries?.map(project) ?? null,
    busy: value.busy,
    error: value.error == null ? null : presentError(value.error),
  };
}
const rule = (entry: ForwardInfo): ForwardInfo => ({
  ...forwardingSavePayload(entry),
  groupId: entry.groupId ?? null,
  revision: entry.revision,
  active: entry.active,
  sessionId: entry.sessionId,
  runtimeId: entry.runtimeId ?? null,
  ...(entry.automation
    ? {
        automation: {
          autoStart: entry.automation.autoStart,
          autoRetry: entry.automation.autoRetry,
        },
      }
    : {}),
  ...(entry.automationStatus
    ? {
        automationStatus: {
          phase: entry.automationStatus.phase,
          retryAt: entry.automationStatus.retryAt,
          error:
            entry.automationStatus.error == null
              ? null
              : presentError(entry.automationStatus.error),
        },
      }
    : {}),
});
export function forwardingReadData(): ForwardingReadData {
  const hosts = useHosts.getState();
  return {
    hosts: hosts.hosts.map(connectionPromptHost),
    hostsLoading: hosts.loading && !hosts.loaded,
    sessions: useSsh
      .getState()
      .sessions.map(({ id, hostId, purpose }) => ({ id, hostId, purpose })),
    rules: snapshot(forwardingStore.getSnapshot(), rule),
    groups: snapshot(forwardingGroupsStore.getSnapshot(), ({ id, hostId, name, revision }) => ({
      id,
      hostId,
      name,
      revision,
    })),
  };
}

/** The coordinator retains the SAME native readers as visible local surfaces.
 * A publisher subscription alone does not start I/O. Satellites consume an
 * explicit projection and never acquire this source or bootstrap SSH workers. */
export function createForwardingReadSource() {
  const store = createStore<ForwardingReadData>(forwardingReadData);
  const readers = new Set<symbol>();
  let disposed = false;
  let cleanups: (() => void)[] = [];
  const update = () => {
    if (!disposed && readers.size) store.setState(forwardingReadData(), true);
  };
  const release = () => {
    for (const cleanup of cleanups.splice(0)) cleanup();
  };
  return {
    store,
    snapshot: forwardingReadData,
    retain() {
      if (disposed) throw new Error("panel.window.disposed");
      if (usePanelWindows.getState().windowId !== "main")
        throw new Error("panel.window.coordinatorRequired");
      const id = Symbol("forwarding-read-source");
      readers.add(id);
      if (readers.size === 1) {
        cleanups = [
          forwardingStore.subscribe(update),
          forwardingGroupsStore.subscribe(update),
          useHosts.subscribe(update),
          useSsh.subscribe(update),
        ];
        update();
      }
      return () => {
        if (!readers.delete(id)) return;
        if (!readers.size) release();
      };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      readers.clear();
      release();
    },
  };
}
