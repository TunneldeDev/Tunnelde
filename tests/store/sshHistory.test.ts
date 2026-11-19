import { expect, it } from "vitest";
import type { SshSession } from "@/lib/api/types";
import { recordSessionEvent, type SessionHistory } from "@/store/sshHistory";

const session = (id: string): SshSession => ({
  id,
  hostId: "host",
  title: "Server",
  address: "user@server:22",
  connectedAt: 100,
  cols: 80,
  rows: 24,
});
it("bounds ended sessions without evicting live sessions", () => {
  let history: SessionHistory[] = [];
  history = recordSessionEvent(history, session("live"), "connected");
  for (let n = 0; n < 100; n++) history = recordSessionEvent(history, session(String(n)), "ended");
  expect(history).toHaveLength(31);
  expect(history.filter((h) => h.endedAt !== null)).toHaveLength(30);
  expect(history.some((h) => h.session.id === "live")).toBe(true);
  expect(history[0]!.session.id).toBe("99");
});
it("bounds repeated events and does not duplicate connection events on refresh", () => {
  let history: SessionHistory[] = [];
  for (let n = 0; n < 30; n++) {
    history = recordSessionEvent(history, session("live"), "connected");
  }
  expect(history[0]!.events).toEqual([{ kind: "connected", at: 100 }]);
  for (let n = 0; n < 30; n++) {
    history = recordSessionEvent(history, session("live"), "disconnectFailed", String(n));
  }
  expect(history[0]!.events).toHaveLength(20);
  expect(history[0]!.events.at(-1)?.detail).toBe("29");
});
