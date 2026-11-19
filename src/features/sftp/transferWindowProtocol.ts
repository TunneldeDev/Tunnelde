import type { ConnectionPromptHost, PromptCredentials } from "@/features/connect/prompt";
import type { TransferLocationKind } from "./transferView";

export type TransferControlOperation =
  | { operation: "pause" | "cancel" | "clear" }
  | { operation: "speedLimit"; kib: number }
  | { operation: "inspect"; location: TransferLocationKind };
export type TransferPromptOperation =
  | { operation: "prepare" | "close" }
  | { operation: "probe"; credentials: PromptCredentials }
  | {
      operation: "trust";
      fingerprint: string;
      expectedHostId: string;
      credentials: PromptCredentials;
    }
  | {
      operation: "connect";
      password: string | null;
      passphrase: string | null;
      credentials: PromptCredentials;
    }
  | { operation: "test"; id: string; credentials: PromptCredentials }
  | { operation: "cancelTest"; id: string }
  | { operation: "credential"; hostId: string; password: string | null }
  | { operation: "installKey"; password: string | null; credentials: PromptCredentials };
export type TransferWindowAction =
  | { kind: "transfer"; key: string; ticket: string; command: TransferControlOperation }
  | { kind: "transferResume"; key: string; ticket: string; interaction: string }
  | {
      kind: "transferPrompt";
      key: string;
      ticket: string;
      interaction: string;
      handle: string;
      command: TransferPromptOperation;
    };
export interface TransferResumeResult {
  prompt?: { handle: string; host: ConnectionPromptHost };
}
export interface TransferPromptPlan {
  jumpHosts: ConnectionPromptHost[];
  saved: Record<string, boolean>;
}
