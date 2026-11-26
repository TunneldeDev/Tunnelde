import type { SshSession } from "@/lib/api/types";
import type { WindowModelAppearance } from "@/app/panelReadModels";
import type { TerminalViewPreferences } from "./terminalViewServices";
export interface TerminalWindowModel extends WindowModelAppearance {
  terminal: {
    session: SshSession;
    closed: boolean;
    disconnecting: boolean;
    preferences: TerminalViewPreferences;
    providerSelected: boolean;
  };
}
export type TerminalWindowCommand =
  | { operation: "disconnect" | "openSftp" | "openMonitor" | "openHistory" | "clipboardRead" }
  | { operation: "clipboardWrite"; text: string }
  | { operation: "font"; font: string }
  | { operation: "recordCommand"; command: string };
