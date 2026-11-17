import type { Host, HostInput } from "./types";

export interface SshConfigIssue {
  code:
    | "readFailed"
    | "tooLarge"
    | "invalidLine"
    | "unsupportedOption"
    | "invalidValue"
    | "missingJump"
    | "existingConflict"
    | "includeCycle";
  detail: string;
}

export interface SshConfigEntry {
  alias: string;
  input: HostInput | null;
  jumpAliases: string[];
  issues: SshConfigIssue[];
  existingId: string | null;
}

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
