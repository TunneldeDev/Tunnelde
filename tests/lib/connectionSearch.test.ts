import { expect, it } from "vitest";
import { parseSearchQuery } from "@/lib/search/query";
import {
  CONNECTION_FILTER_KEYS,
  matchesConnection,
  connectionStatus,
} from "@/lib/session/connectionSearch";
import type { SshSession } from "@/lib/api/types";
const session = {
  id: "id-123",
  hostId: "host-1",
  title: "Production",
  address: "root@example:22",
  terminal: false,
  purpose: "forwarding",
} as SshSession;
const matches = (q: string) =>
  matchesConnection(parseSearchQuery(q, CONNECTION_FILTER_KEYS), session, {
    host: "生产主机",
    status: "connected",
    labels: ["端口转发"],
  });
it("combines plain text, localized labels, OR filter values and exclusions", () => {
  expect(matches("root @type:terminal,forwarding @status:connected -@host:staging")).toBe(true);
  expect(matches('端口转发 @host:"生产主机"')).toBe(true);
  expect(matches("id-123 @host:host-1")).toBe(true);
  expect(matches("root @type:terminal")).toBe(false);
  expect(matches("root -@status:connected")).toBe(false);
  expect(matches("root @status:ended")).toBe(false);
  expect(matches("root @unknown:connected")).toBe(false);
});
it("gives ended and pending native state precedence over past failure events", () => {
  const history = { events: [{ kind: "disconnectFailed" }] } as never;
  expect(connectionStatus(false, false, history)).toBe("failed");
  expect(connectionStatus(false, true, history)).toBe("disconnecting");
  expect(connectionStatus(true, false, history)).toBe("ended");
});
