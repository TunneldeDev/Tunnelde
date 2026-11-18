import type { Host } from "./types";
import type { SshConfigEntry, SshConfigIssue } from "../extensions/contracts/hosts/sshConfig";
export type { SshConfigEntry, SshConfigIssue } from "../extensions/contracts/hosts/sshConfig";

export interface SshConfigPreview {
  path: string;
  found: boolean;
  revision: string;
  entries: SshConfigEntry[];
  issues: SshConfigIssue[];
}

export interface SshConfigImportResult {
  imported: Host[];
  skipped: number;
}
