import type {
  ConnectionQuality,
  Host,
  HostKeyInfo,
  SshConnectRequest,
  SshSession,
} from "@/lib/api/types";

/** Display-only host metadata. Never clone writable host/credential stores into
 * a satellite just to render a connection prompt. */
export type ConnectionPromptHost = Pick<
  Host,
  "id" | "name" | "host" | "port" | "username" | "authMethod"
> & { source?: boolean };
export function connectionPromptHost({
  id,
  name,
  host,
  port,
  username,
  authMethod,
  source,
}: Host): ConnectionPromptHost {
  return { id, name, host, port, username, authMethod, ...(source ? { source: true } : {}) };
}
export type PromptCredentials = NonNullable<SshConnectRequest["jumpCredentials"]>;

/** The prompt owns UI only. A native-window adapter must acquire its exact
 * lease consent guard before mounting it, and relay every effect through the
 * singleton coordinator with its independent native action fence. No raw IPC
 * fallbacks belong in this interface or in ConnectionPrompt. */
export interface ConnectionPromptServices {
  prepare: () => Promise<{ jumpHosts: ConnectionPromptHost[] }>;
  credentialStatus: (hostId: string) => Promise<boolean>;
  probe: (credentials: PromptCredentials) => Promise<HostKeyInfo>;
  trust: (
    fingerprint: string,
    credentials: PromptCredentials,
    expectedHostId: string,
  ) => Promise<HostKeyInfo>;
  connect: (request: SshConnectRequest) => Promise<SshSession | null>;
  test: (id: string, credentials: PromptCredentials) => Promise<ConnectionQuality>;
  cancelTest: (id: string) => Promise<void>;
  credential: (hostId: string, password: string | null) => Promise<void>;
  installKey: (password: string | null, credentials: PromptCredentials) => Promise<unknown>;
}
