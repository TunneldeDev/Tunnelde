import type { FrontendForwardingEntry } from "../contracts/forwarding/entry";
import type {
  FrontendForwarding,
  FrontendForwardingSnapshot,
} from "../contracts/forwarding/provider";
import type { ForwardingAuthority } from "./authority";

export interface ForwardingActions {
  validate(): boolean;
  refresh(): void;
  start(
    entries: readonly Readonly<FrontendForwardingEntry>[],
    authority: ForwardingAuthority,
  ): void;
  stop(entry: Readonly<FrontendForwardingEntry>, authority: ForwardingAuthority): void;
  requestAdd(authority: ForwardingAuthority): void;
  requestEdit(entry: Readonly<FrontendForwardingEntry>, authority: ForwardingAuthority): void;
  requestRemove(entry: Readonly<FrontendForwardingEntry>, authority: ForwardingAuthority): void;
  requestDisconnect(authority: ForwardingAuthority): void;
}
export type ForwardingContext = Pick<FrontendForwarding, "snapshot" | "read" | "refresh"> & {
  start(id: string, authority: ForwardingAuthority): void;
  startAll(authority: ForwardingAuthority): void;
  stop(id: string, authority: ForwardingAuthority): void;
  requestAdd(authority: ForwardingAuthority): void;
  requestEdit(id: string, authority: ForwardingAuthority): void;
  requestRemove(id: string, authority: ForwardingAuthority): void;
  requestDisconnect(authority: ForwardingAuthority): void;
};

/** One immutable bounded revision; no session IDs, stores or arbitrary endpoint injection. */
export function createForwardingContext(
  snapshot: FrontendForwardingSnapshot,
  entries: readonly FrontendForwardingEntry[],
  live: () => void,
  actions: ForwardingActions,
): ForwardingContext {
  const rows = Object.freeze(
    entries.map((entry) =>
      Object.freeze({
        id: entry.id,
        hostId: entry.hostId,
        name: entry.name,
        mode: entry.mode,
        bindHost: entry.bindHost,
        bindPort: entry.bindPort,
        targetHost: entry.targetHost,
        targetPort: entry.targetPort,
        revision: entry.revision,
        active: entry.active,
        runtimeId: entry.runtimeId,
      }),
    ),
  );
  const data = Object.freeze({ ...snapshot, total: rows.length });
  const byId = new Map(rows.map((row) => [row.id, row]));
  const ready = (mutation = false) => {
    live();
    if (!actions.validate()) throw new Error("plugin.forwarding.changed");
    if (mutation && (data.busy || data.editing))
      throw new Error("plugin.forwarding.busy");
  };
  const entry = (id: string) => {
    ready(true);
    const row = typeof id === "string" ? byId.get(id) : undefined;
    if (!row || row.hostId !== data.hostId) throw new Error("plugin.forwarding.invalid");
    return row;
  };
  return Object.freeze<ForwardingContext>({
    snapshot: data,
    read: (request) => {
      if (!request || typeof request !== "object") throw new Error("plugin.forwarding.invalid");
      if (request.revision !== data.revision) throw new Error("plugin.forwarding.changed");
      const offset = request.offset ?? 0;
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > rows.length)
        throw new Error("plugin.forwarding.invalid");
      const items: Readonly<FrontendForwardingEntry>[] = [];
      let next = offset,
        size = 0;
      for (; next < rows.length && items.length < 128; next++) {
        const row = rows[next]!;
        const length =
          row.id.length +
          row.hostId.length +
          row.name.length +
          row.bindHost.length +
          row.targetHost.length +
          row.revision.length +
          (row.runtimeId?.length ?? 0);
        if (size + length > 65536) break;
        size += length;
        items.push(row);
      }
      if (next === offset && next < rows.length) throw new Error("plugin.forwarding.invalid");
      return Object.freeze({
        revision: data.revision,
        total: rows.length,
        nextOffset: next < rows.length ? next : null,
        items: Object.freeze(items),
      });
    },
    refresh: () => {
      ready();
      actions.refresh();
    },
    start: (id, authority) => {
      const row = entry(id);
      if (row.active) throw new Error("forward.alreadyActive");
      actions.start([row], authority);
    },
    startAll: (authority) => {
      ready(true);
      actions.start(
        rows.filter((row) => !row.active),
        authority,
      );
    },
    stop: (id, authority) => {
      const row = entry(id);
      if (!row.active || !row.runtimeId) throw new Error("plugin.forwarding.changed");
      actions.stop(row, authority);
    },
    requestAdd: (authority) => {
      ready(true);
      actions.requestAdd(authority);
    },
    requestEdit: (id, authority) => {
      const row = entry(id);
      if (row.active) throw new Error("forward.stopBeforeEdit");
      actions.requestEdit(row, authority);
    },
    requestRemove: (id, authority) => actions.requestRemove(entry(id), authority),
    requestDisconnect: (authority) => {
      ready(true);
      if (!data.connected) throw new Error("ssh.sessionMissing");
      actions.requestDisconnect(authority);
    },
  });
}
