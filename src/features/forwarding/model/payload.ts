import type { ForwardRule } from "./contract";

export function forwardingSavePayload(rule: ForwardRule): ForwardRule {
  const { id, hostId, name, mode, bindHost, bindPort, targetHost, targetPort } = rule;
  return { id, hostId, name, mode, bindHost, bindPort, targetHost, targetPort };
}
export const initialForwardRule = (hostId: string): ForwardRule => ({
  id: "",
  hostId,
  name: "",
  mode: "local",
  bindHost: "127.0.0.1",
  bindPort: 8080,
  targetHost: "127.0.0.1",
  targetPort: 80,
});
