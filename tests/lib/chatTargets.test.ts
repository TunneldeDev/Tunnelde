import { describe, expect, it } from "vitest";
import { chatTargets } from "@/lib/plugins/chatTargets";
import type { SshSession } from "@/lib/api/types";

const session: SshSession = {
  id: "first",
  hostId: "host",
  title: "Server",
  address: "user@server:22",
  cols: 80,
  rows: 24,
  connectedAt: 1,
};

describe("assistant machine targets", () => {
  it("prefers the selected connection and otherwise the newest connection to a machine", () => {
    const newer = { ...session, id: "second", connectedAt: 2 };
    expect(chatTargets([session, newer], [], "first").map((item) => item.id)).toEqual(["first"]);
    expect(chatTargets([newer, session], [], "first").map((item) => item.id)).toEqual(["first"]);
    expect(chatTargets([newer, session], []).map((item) => item.id)).toEqual(["second"]);
  });
  it("keeps different addresses and independently saved hosts separate even when labels match", () => {
    const changedAddress = { ...session, id: "changed-address", address: "user@other:22" };
    const differentHost = { ...session, id: "different-host", hostId: "other-host" };
    expect(chatTargets([session, changedAddress, differentHost], [])).toHaveLength(3);
    expect(
      chatTargets(
        [
          session,
          { ...session, id: "unbound-one", hostId: "" },
          { ...session, id: "unbound-two", hostId: "" },
        ],
        [],
      ),
    ).toHaveLength(3);
  });
});
