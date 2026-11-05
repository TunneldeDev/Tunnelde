import { describe, expect, it } from "vitest";
import { forwardingSavePayload } from "@/features/forwarding/ForwardingSection";

describe("forwardingSavePayload", () => {
  it("removes runtime status fields when saving an existing rule", () => {
    const rule = {
      id: "rule",
      hostId: "host",
      name: "Web",
      mode: "local" as const,
      bindHost: "127.0.0.1",
      bindPort: 8080,
      targetHost: "localhost",
      targetPort: 80,
      active: false,
      sessionId: null,
    };
    expect(forwardingSavePayload(rule)).toEqual({
      id: "rule",
      hostId: "host",
      name: "Web",
      mode: "local",
      bindHost: "127.0.0.1",
      bindPort: 8080,
      targetHost: "localhost",
      targetPort: 80,
    });
  });
});
