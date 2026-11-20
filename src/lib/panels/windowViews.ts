import { create } from "zustand";
import type { PanelWindowClient } from "./windowClient";
import type { NativePanelSnapshot, PanelLease, PanelTransferOffer } from "./windowProtocol";
import { createPanelViewState, parsePanelViewCapsule, type PanelViewState } from "./viewState";
import { parsePanelDomState, type PanelDomState } from "./domState";

// Adapters are deliberately opt-in. Never acknowledge a view we cannot render.
export const transferablePanel = (id: string) =>
  id === "connections" || id === "tasks" || id === "output" || id === "knownHosts";
export interface WindowViewRecord {
  key: string;
  panelId: string;
  controller: PanelViewState;
  dom?: PanelDomState;
  staged: boolean;
  moving?: boolean;
  /** Capture BEFORE inert blurs the source; contains geometry/caret, no values. */
  frozenDom?: PanelDomState;
  failed?: boolean;
  lease?: PanelLease;
}
export const useWindowViews = create<{ entries: ReadonlyMap<string, WindowViewRecord> }>(() => ({
  entries: new Map(),
}));
function parseTransfer(value: unknown) {
  if (value === null) return {};
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("panel.viewState.invalid");
  const state = value as { version?: unknown; view?: unknown; dom?: unknown };
  if (state.version !== 1) throw new Error("panel.viewState.invalid");
  return { view: parsePanelViewCapsule(state.view), dom: parsePanelDomState(state.dom) };
}

/** Document-local UI ownership. A staged tree is mounted inert before native
 * acknowledges it; commit promotes that SAME tree. No feature bootstrap lives
 * here, and capsules never go into persisted workspace/presentation stores. */
export function createWindowViews(client: PanelWindowClient) {
  const records = new Map<string, WindowViewRecord>();
  const roots = new Map<string, () => PanelDomState>();
  const ready = new Map<string, (failure?: { error: unknown }) => void>();
  const revisions = new Map<string, number>();
  let disposed = false,
    epoch = 0;
  const publish = () => {
    if (!disposed) useWindowViews.setState({ entries: new Map(records) });
  };
  const remove = (id: string) => {
    records.get(id)?.controller.dispose();
    records.delete(id);
    roots.delete(id);
    for (const key of revisions.keys()) if (key.startsWith(`${id}:`)) revisions.delete(key);
  };
  const create = (panelId: string, key: string, state: unknown, staged: boolean) => {
    const parsed = parseTransfer(state);
    const record: WindowViewRecord = {
      key,
      panelId,
      controller: createPanelViewState(parsed.view),
      dom: parsed.dom,
      staged,
    };
    records.set(panelId, record);
    return record;
  };
  const captureAsync = async (panelId: string, signal?: AbortSignal) => {
    const record = records.get(panelId),
      root = roots.get(panelId);
    if (!record?.lease || record.staged || record.failed || !root || disposed)
      throw new Error("panel.window.viewNotReady");
    const owner = record.lease;
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    const timer = setTimeout(abort, 15_000);
    try {
      for (;;) {
        let view;
        try {
          view = await record.controller.captureAsync(controller.signal);
        } catch (error) {
          if (
            !controller.signal.aborted &&
            error instanceof Error &&
            error.message === "panel.viewState.changedDuringCapture"
          )
            continue;
          throw error;
        }
        const current = records.get(panelId);
        if (
          disposed ||
          controller.signal.aborted ||
          current?.controller !== record.controller ||
          current.staged ||
          current.failed ||
          current.lease?.generation !== owner.generation ||
          roots.get(panelId) !== root
        )
          throw new Error("panel.window.staleOwner");
        return {
          version: 1,
          view,
          dom: current.moving && current.frozenDom ? current.frozenDom : root(),
        };
      }
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  };
  return {
    client,
    close: undefined as (() => Promise<void>) | undefined,
    async reconcile(snapshot: NativePanelSnapshot) {
      const currentEpoch = ++epoch;
      const owned = snapshot.panels.filter(
        (lease) => lease.windowId === client.windowId && transferablePanel(lease.panelId),
      );
      const incoming = new Set(
        snapshot.transfers
          .filter(({ offer }) => offer.targetWindow === client.windowId)
          .map(({ offer }) => offer.id),
      );
      for (const [id, record] of records) {
        if (
          !owned.some((lease) => lease.panelId === id) &&
          !(record.staged && incoming.has(record.key))
        )
          remove(id);
      }
      publish();
      for (const lease of owned) {
        if (disposed || currentEpoch !== epoch) return;
        const record = records.get(lease.panelId);
        if (record?.staged || record?.lease?.generation === lease.generation) {
          if (record.staged || record.lease?.generation !== lease.generation)
            records.set(lease.panelId, { ...record, staged: false, lease });
          continue;
        }
        const state = await client.control({ action: "view", lease });
        if (disposed || currentEpoch !== epoch) return;
        remove(lease.panelId);
        create(lease.panelId, `lease:${lease.generation}`, state, false).lease = lease;
      }
      publish();
    },
    stage(offer: PanelTransferOffer, state: unknown, signal: AbortSignal): Promise<void> {
      if (disposed || signal.aborted) return Promise.reject(new Error("panel.window.disposed"));
      if (!transferablePanel(offer.lease.panelId))
        return Promise.reject(new Error("panel.window.unsupportedView"));
      const existing = records.get(offer.lease.panelId);
      if (existing) return Promise.reject(new Error("panel.window.duplicateView"));
      create(offer.lease.panelId, offer.id, state, true);
      return new Promise<void>((resolve, reject) => {
        const abort = () => {
          ready.delete(offer.id);
          if (records.get(offer.lease.panelId)?.key === offer.id) remove(offer.lease.panelId);
          publish();
          reject(new Error("panel.window.cancelled"));
        };
        ready.set(offer.id, (failure) => {
          ready.delete(offer.id);
          signal.removeEventListener("abort", abort);
          if (failure) {
            if (records.get(offer.lease.panelId)?.key === offer.id) remove(offer.lease.panelId);
            publish();
            reject(failure.error);
          } else resolve();
        });
        signal.addEventListener("abort", abort, { once: true });
        publish();
      });
    },
    rendered(key: string) {
      ready.get(key)?.();
    },
    renderFailed(key: string, error: unknown) {
      for (const [id, record] of records) {
        if (record.key !== key) continue;
        records.set(id, { ...record, failed: true });
        break;
      }
      ready.get(key)?.({ error });
      publish();
    },
    registerRoot(panelId: string, capture: () => PanelDomState) {
      roots.set(panelId, capture);
      return () => {
        if (roots.get(panelId) === capture) roots.delete(panelId);
      };
    },
    setMoving(panelId: string, moving: boolean, expected?: PanelLease) {
      const record = records.get(panelId);
      if (
        record &&
        (!expected ||
          (record.lease?.windowId === expected.windowId &&
            record.lease.generation === expected.generation))
      ) {
        const frozenDom = moving && !record.moving ? roots.get(panelId)?.() : record.frozenDom;
        records.set(panelId, { ...record, moving, frozenDom });
        publish();
      }
    },
    async checkpoint(panelId: string) {
      const record = records.get(panelId),
        root = roots.get(panelId);
      if (!record?.lease || record.staged || record.failed || !root || disposed) return;
      const key = `${panelId}:${record.lease.generation}`;
      const revision = (revisions.get(key) ?? 0) + 1;
      revisions.set(key, revision);
      const state = await captureAsync(panelId);
      if (disposed || records.get(panelId)?.controller !== record.controller) return;
      await client.control({ action: "checkpoint", lease: record.lease, revision, state });
    },
    captureAsync,
    capture(panelId: string) {
      const record = records.get(panelId),
        root = roots.get(panelId);
      if (!record?.lease || record.staged || record.failed || !root)
        throw new Error("panel.window.viewNotReady");
      return {
        version: 1,
        view: record.controller.capture(),
        dom: record.moving && record.frozenDom ? record.frozenDom : root(),
      };
    },
    dispose() {
      disposed = true;
      epoch++;
      for (const id of records.keys()) remove(id);
      for (const done of ready.values()) done({ error: new Error("panel.window.disposed") });
      ready.clear();
      useWindowViews.setState({ entries: new Map() });
    },
  };
}
export type WindowViews = ReturnType<typeof createWindowViews>;
let current: WindowViews | null = null;
export function windowViews() {
  return current;
}
export function installWindowViews(views: WindowViews) {
  if (current) throw new Error("panel.window.alreadyInstalled");
  current = views;
  return () => {
    if (current === views) {
      current = null;
      views.dispose();
    }
  };
}
