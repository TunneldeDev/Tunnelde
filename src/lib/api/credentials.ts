import type { ConnectionRoute, ProxyProfile } from "./network";
import type { Host, HostInput, Settings } from "./types";

/** Private desktop editor IPC, separate from stable automation/plugin DTOs. */
export type CredentialChange =
  { action: "keep" } | { action: "save"; password: string } | { action: "forget" };

export interface HostEdit {
  id: string | null;
  input: HostInput;
  route: ConnectionRoute;
  credential: CredentialChange;
}
export interface HostSaved {
  host: Host;
  credentialError: unknown | null;
}
export interface ProxySaved {
  settings: Settings;
  credentialError: unknown | null;
}
export interface ProxyEdit {
  profile: ProxyProfile;
  credential: CredentialChange;
}
