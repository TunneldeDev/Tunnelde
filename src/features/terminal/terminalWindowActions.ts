import type { PanelLease } from "@/lib/panels/windowProtocol";
import type { TerminalWindowCommand } from "./terminalWindowModel";
import { terminalDisplaySession } from "./terminalWindowPublication";
import { useWorkspace } from "@/store/workspace";
import { useSettings } from "@/store/settings";
import { useSsh } from "@/store/ssh";
import { api } from "@/lib/api/ipc";
import { MONO_FONT_OPTIONS } from "@/lib/prefs/defaults";
import type { MonoFont } from "@/lib/api/types";
import { recordTerminalCommand } from "@/lib/session/history";
/** Native admission already pins the exact bound resource/lease through this
 * effect. The request cannot name another session/host or arbitrary preference. */
export async function executeTerminalWindowAction(
  lease: PanelLease,
  command: TerminalWindowCommand,
  show: () => Promise<unknown>,
) {
  if (
    !lease.panelId.startsWith("terminal:") ||
    !useWorkspace.getState().tabs.some((tab) => tab.kind === "terminal" && tab.id === lease.panelId)
  )
    throw new Error("panel.window.staleOwner");
  const session = terminalDisplaySession(lease.panelId);
  if (!session) throw new Error("ssh.sessionMissing");
  switch (command.operation) {
    case "disconnect": {
      let failure: unknown;
      await useSsh.getState().disconnect(session.id, (error) => {
        failure = error;
      });
      if (failure) throw failure;
      return null;
    }
    case "openProcesses":
    case "openMonitor":
    case "openSftp":
    case "openHistory":
      if (!useSsh.getState().sessions.some((item) => item.id === session.id))
        throw new Error("ssh.sessionMissing");
      await show();
      if (command.operation === "openSftp") useWorkspace.getState().openSftp(session);
      else if (command.operation === "openProcesses")
        useWorkspace.getState().openProcesses(session);
      else if (command.operation === "openMonitor") useWorkspace.getState().openMonitor(session);
      else useWorkspace.getState().openHistory(session);
      return null;
    case "font":
      if (!MONO_FONT_OPTIONS.some((option) => option.value === command.font))
        throw new Error("invalid:monoFont");
      await useSettings.getState().update({ monoFont: command.font as MonoFont });
      return null;
    case "clipboardRead":
      return api.clipboardReadText();
    case "clipboardWrite":
      await api.clipboardWriteText(command.text);
      return null;
    case "recordCommand":
      if (useSettings.getState().settings.recordTerminalHistory && session.hostId)
        await recordTerminalCommand(session.hostId, command.command);
      return null;
  }
}
