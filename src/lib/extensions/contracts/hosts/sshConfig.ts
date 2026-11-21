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
  input: {
    name: string;
    groupId: string | null;
    host: string;
    port: number;
    username: string;
    authMethod: "agent" | "key";
    keyPath: string | null;
    favorite: boolean;
    color: string | null;
    tags: string[];
    note: string | null;
  } | null;
  jumpAliases: string[];
  issues: SshConfigIssue[];
  existingId: string | null;
}

export interface SshConfigPreviewRequest {
  offset?: number;
  revision?: string;
}

export interface SshConfigPreviewPage {
  found: boolean;
  revision: string;
  entries: SshConfigEntry[];
  total: number;
  nextOffset: number | null;
  issues: SshConfigIssue[];
}

export interface SshConfigImportRequest {
  aliases: string[];
  revision: string;
}

export interface SshConfigImportReceipt {
  importedIds: string[];
  skipped: number;
}
