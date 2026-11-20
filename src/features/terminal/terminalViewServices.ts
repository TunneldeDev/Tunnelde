import type { ComponentType, ReactNode } from "react";
import type { MonoFont, Settings, SshSession } from "@/lib/api/types";
import type { api, events } from "@/lib/api/ipc";
import type { TerminalCheckpoint, TerminalParticipant } from "./terminalCheckpoint";
import type { TerminalBridge } from "@/lib/extensions/terminal/bridge";

/** Explicit terminal-only projection. Never hydrate the writable main settings
 * store in a satellite or send proxy profiles, grants or saved credentials. */
export const terminalPreferenceKeys = [
  "theme",
  "colors",
  "motion",
  "monoFont",
  "monoFontSize",
  "lightweightMode",
  "terminalLineHeight",
  "terminalCursorStyle",
  "terminalCursorBlink",
  "terminalInactiveCursorStyle",
  "terminalScrollback",
  "terminalScrollSensitivity",
  "terminalSmoothScrolling",
  "terminalScrollOnInput",
  "terminalRenderer",
  "terminalApplicationClipboard",
  "terminalCopyOnSelect",
  "terminalRightClick",
  "recordTerminalHistory",
  "keyboardShortcuts",
  "shortcutRules",
] as const satisfies readonly (keyof Settings)[];
export type TerminalViewPreferences = Pick<Settings, (typeof terminalPreferenceKeys)[number]>;
export function terminalPreferenceProjection(settings: Settings): TerminalViewPreferences {
  return Object.fromEntries(
    terminalPreferenceKeys.map((key) => [key, settings[key]]),
  ) as TerminalViewPreferences;
}
export interface TerminalSettingsSource {
  read(): TerminalViewPreferences;
  subscribe(changed: () => void): () => void;
}
export interface TerminalViewServices {
  native: boolean;
  session: SshSession | null;
  disconnecting: boolean;
  settings: TerminalSettingsSource;
  io: Pick<
    typeof api,
    | "sshAttach"
    | "sshDetach"
    | "sshWrite"
    | "sshResize"
    | "sshDisconnect"
    | "clipboardReadText"
    | "clipboardWriteText"
  >;
  events: Pick<typeof events, "onSshData" | "onSshClosed">;
  disconnect(sessionId: string): Promise<unknown>;
  openSftp(session: SshSession): void;
  openHistory(session: SshSession): void;
  updateFont(font: MonoFont): Promise<unknown>;
  recordCommand(hostId: string, command: string): Promise<unknown>;
  copy(text: string): void;
  dialogOpen(): boolean;
  /** A view-only migration failure is never authority to destroy its PTY. */
  releaseOnFailure: boolean;
  checkpoints: {
    take(sessionId: string): TerminalCheckpoint | undefined;
    register(sessionId: string, participant: TerminalParticipant): () => void;
  };
  /** Called only after parser/modes/listeners have been restored. A staged view
   * can acknowledge readiness here while attach waits for ownership commit. */
  rendered?(): void;
  failed?(error: unknown): void;
  Surface?: ComponentType<{ bridge: TerminalBridge | null; visible: boolean; children: ReactNode }>;
}
