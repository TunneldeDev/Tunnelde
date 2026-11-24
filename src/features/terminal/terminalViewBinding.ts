import type { AsyncPanelCapture } from "@/lib/panels/viewCapture";
import type { PanelWindowClient } from "@/lib/panels/windowClient";
import type { PanelLease } from "@/lib/panels/windowProtocol";
import { useWindowViews, type WindowViewRecord } from "@/lib/panels/windowViews";
import { usePanelWindows } from "@/store/panelWindows";
import {
  beginTerminalHandoff,
  registerTerminalCheckpoint,
  takeTerminalCheckpoint,
  type TerminalHandoff,
} from "./terminalCheckpoint";
import { decodeTerminalCheckpoint, encodeTerminalCheckpoint } from "./terminalCheckpointCodec";
import type { TerminalViewPreferences, TerminalViewServices } from "./terminalViewServices";
import type { TerminalWindowModel, TerminalWindowCommand } from "./terminalWindowModel";
import { events } from "@/lib/api/ipc";
import type { SshDataPayload, SshClosedPayload } from "@/lib/api/types";
import { toast } from "@/store/toasts";
import { presentError } from "@/lib/api/errors";

const streamQueues = new WeakMap<PanelWindowClient, Map<string, Promise<unknown>>>();
/** One exact renderer instance. Native remains the authority for every effect.
 * No SSH bootstrap, mutable main stores or public stream event subscription. */
export function createTerminalViewBinding(
  client: PanelWindowClient,
  record: WindowViewRecord,
  initial: TerminalWindowModel,
) {
  const sessionId = initial.terminal.session.id;
  if (record.panelId !== `terminal:${sessionId}`) throw new Error("panel.window.staleOwner");
  let model = initial,
    disposed = false,
    lease: PanelLease | undefined,
    handoff: TerminalHandoff | undefined;
  const listeners = new Set<() => void>(),
    data = new Set<(payload: SshDataPayload) => void>();
  const waiters = new Set<{
    resolve: (lease: PanelLease) => void;
    reject: (error: Error) => void;
  }>();
  let releaseStream: (() => void) | undefined;
  let readyResolve!: () => void, readyReject!: (error: unknown) => void;
  let ready: Promise<void>;
  const resetReady = () => {
    ready = new Promise<void>((resolve, reject) => {
      readyResolve = resolve;
      readyReject = reject;
    });
    void ready.catch(() => {});
  };
  resetReady();
  const restored = record.controller.read(
    "terminal",
    (value): value is unknown => value !== undefined,
  );
  const closedListeners = new Set<(payload: SshClosedPayload) => void>();
  let closeSeen = initial.terminal.closed;
  const closed = (payload: SshClosedPayload) => {
    if (disposed || closeSeen || payload.sessionId !== sessionId) return;
    closeSeen = true;
    for (const receive of closedListeners) receive(payload);
  };
  const current = () => {
    const row = useWindowViews.getState().entries.get(record.panelId);
    if (disposed || row?.key !== record.key || row.controller !== record.controller || row.failed)
      throw new Error("panel.window.staleOwner");
    return row;
  };
  const owned = (input = true) => {
    const row = current();
    if (
      !lease ||
      row.staged ||
      row.lease?.generation !== lease.generation ||
      row.lease.windowId !== client.windowId ||
      (input && row.moving)
    )
      throw new Error("panel.window.staleOwner");
    return lease;
  };
  const identity = (id: string) => {
    if (id !== sessionId) throw new Error("panel.window.staleOwner");
  };
  const report = (error: unknown) => toast(presentError(error), "error");
  const action = async <T = unknown>(command: TerminalWindowCommand): Promise<T> =>
    client.action<T>(owned(), { kind: "terminal", command });
  const serial = async (work: () => Promise<void>) => {
    let queue = streamQueues.get(client);
    if (!queue) {
      queue = new Map();
      streamQueues.set(client, queue);
    }
    const previous = queue.get(record.panelId) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(work);
    queue.set(record.panelId, next);
    try {
      await next;
    } finally {
      if (queue.get(record.panelId) === next) queue.delete(record.panelId);
    }
  };
  const finishHandoff = async () => {
    const pending = handoff;
    if (!pending) return;
    const owner = usePanelWindows
      .getState()
      .snapshot.panels.find((panel) => panel.panelId === record.panelId);
    if (
      owner &&
      (owner.windowId !== client.windowId || (lease && owner.generation !== lease.generation))
    )
      await pending.commit();
    else await pending.rollback();
    if (handoff === pending) handoff = undefined;
  };
  const settings = {
    read: (): TerminalViewPreferences => model.terminal.preferences,
    subscribe: (changed: () => void) => {
      listeners.add(changed);
      return () => {
        listeners.delete(changed);
      };
    },
  };
  const services: TerminalViewServices = {
    native: true,
    closed: initial.terminal.closed,
    session: initial.terminal.session,
    disconnecting: initial.terminal.disconnecting,
    isolatedShortcuts: client.windowId !== "main",
    settings,
    io: {
      sshAttach: async (id) => {
        identity(id);
        const active = lease
          ? owned(false)
          : await new Promise<PanelLease>((resolve, reject) => {
              current();
              waiters.add({ resolve, reject });
            });
        await serial(async () => {
          const now = owned(false);
          if (now.generation !== active.generation) throw new Error("panel.window.staleOwner");
          // Clear a revoked document's sink before attaching this restored tree.
          await client.terminals.detach(now);
          if (owned(false).generation !== now.generation)
            throw new Error("panel.window.staleOwner");
          releaseStream?.();
          releaseStream = await client.terminals.attach(now, (packet) => {
            if (disposed) return;
            const payload = { sessionId, ...packet };
            for (const receive of data) receive(payload);
          });
        });
      },
      sshDetach: async (id) => {
        identity(id);
        return client.terminals.detach(owned(false));
      },
      sshWrite: async (id, bytes) => {
        identity(id);
        await client.terminals.write(owned(), bytes);
      },
      sshResize: async (id, cols, rows) => {
        identity(id);
        await client.terminals.resize(owned(), cols, rows);
      },
      sshDisconnect: async (id) => {
        identity(id);
        await action({ operation: "disconnect" });
      },
      clipboardReadText: () => action<string>({ operation: "clipboardRead" }),
      clipboardWriteText: async (text) => {
        await action({ operation: "clipboardWrite", text });
      },
    },
    events: {
      onSshData: async (receive) => {
        current();
        data.add(receive);
        return () => {
          data.delete(receive);
        };
      },
      onSshClosed: async (receive) => {
        closedListeners.add(receive);
        const stop = await events.onSshClosed(closed);
        return () => {
          closedListeners.delete(receive);
          stop();
        };
      },
    },
    disconnect: async (id) => {
      identity(id);
      try {
        return await action({ operation: "disconnect" });
      } catch (error) {
        report(error);
      }
    },
    openSftp: () => {
      void action({ operation: "openSftp" }).catch(report);
    },
    openHistory: () => {
      void action({ operation: "openHistory" }).catch(report);
    },
    updateFont: async (font) => {
      try {
        await action({ operation: "font", font });
      } catch (error) {
        report(error);
      }
    },
    recordCommand: async (_host, command) => action({ operation: "recordCommand", command }),
    copy: (text) => {
      void action({ operation: "clipboardWrite", text }).catch(report);
    },
    dialogOpen: () => !!document.querySelector("[role='dialog'][aria-modal='true']"),
    releaseOnFailure: false,
    checkpoints: {
      take: () => {
        return restored
          ? decodeTerminalCheckpoint(restored, "panel")
          : takeTerminalCheckpoint(sessionId);
      },
      register: registerTerminalCheckpoint,
    },
    rendered: () => readyResolve(),
    failed: (error) => readyReject(error),
  };
  const capture: AsyncPanelCapture = async (signal, options) => {
    if (handoff) throw new Error("terminal.checkpointBusy");
    const pending = await beginTerminalHandoff([sessionId], signal);
    let row: WindowViewRecord;
    try {
      row = current();
    } catch (error) {
      await pending.rollback();
      throw error;
    }
    if (options?.intent === "move" && !row.moving) {
      await pending.rollback();
      throw new Error("panel.window.cancelled");
    }
    try {
      const checkpoint = encodeTerminalCheckpoint(pending.checkpoints[sessionId]!, "panel");
      if (options?.intent === "move") handoff = pending;
      else await pending.rollback();
      return checkpoint;
    } catch (error) {
      await pending.rollback().catch(report);
      throw error;
    }
  };
  const observeOwner = () => {
    const row = useWindowViews.getState().entries.get(record.panelId);
    if (handoff && (!row || row.key !== record.key || !row.moving))
      void finishHandoff().catch(report);
  };
  let stopCapture: (() => void) | undefined, stopOwner: (() => void) | undefined;
  return {
    services,
    mount() {
      disposed = false;
      resetReady();
      stopCapture = record.controller.registerAsync("terminal", capture, () => ready);
      stopOwner = useWindowViews.subscribe(observeOwner);
    },
    update(next: TerminalWindowModel) {
      if (next.terminal.session.id !== sessionId) throw new Error("panel.window.staleOwner");
      const previous = model.terminal.preferences;
      model = next;
      if (next.terminal.closed) closed({ sessionId, reason: "closed" });
      services.session = next.terminal.session;
      services.disconnecting = next.terminal.disconnecting;
      services.closed = next.terminal.closed;
      if (previous !== next.terminal.preferences) for (const changed of listeners) changed();
    },
    activate(next?: PanelLease) {
      if (next && (next.panelId !== record.panelId || next.windowId !== client.windowId))
        throw new Error("panel.window.staleOwner");
      lease = next;
      if (next)
        for (const waiter of [...waiters]) {
          waiters.delete(waiter);
          waiter.resolve(next);
        }
    },
    dispose() {
      if (disposed) return;
      void finishHandoff().catch(report);
      disposed = true;
      readyReject(new Error("panel.window.disposed"));
      for (const waiter of waiters) waiter.reject(new Error("panel.window.disposed"));
      waiters.clear();
      stopOwner?.();
      stopCapture?.();
      releaseStream?.();
      data.clear();
      closedListeners.clear();
      listeners.clear();
    },
  };
}
