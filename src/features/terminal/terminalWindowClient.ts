import { Channel, invoke } from "@tauri-apps/api/core";
import type { NativePanelIdentity, PanelLease } from "@/lib/panels/windowProtocol";

export interface TerminalWindowOutput {
  sequence: number;
  data: string;
}
export type TerminalWindowRequest =
  | { action: "bind"; sessionId: string }
  | { action: "unbind"; panelId: string }
  | { action: "configure"; panelId: string; allowMove: boolean }
  | { action: "detach"; lease: PanelLease }
  | { action: "write"; lease: PanelLease; data: string }
  | { action: "resize"; lease: PanelLease; cols: number; rows: number };

/** Host-private stream client. No public bus/event listener or SSH bootstrap.
 * Every operation is independently checked by native document/panel authority.
 * Renderer detach is explicit and barriered; disposing a listener must not send
 * a late detach that could steal a stream already handed to another window. */
export function createTerminalWindowClient(identity: NativePanelIdentity) {
  let disposed = false;
  const listeners = new Set<() => void>();
  const check = () => {
    if (disposed) throw new Error("panel.window.disposed");
  };
  async function request<T>(request: TerminalWindowRequest): Promise<T> {
    check();
    const result = await invoke<T>("panel_window_terminal", {
      document: identity.document,
      request,
    });
    check();
    return result;
  }
  return {
    bind: (sessionId: string) => request<PanelLease>({ action: "bind", sessionId }),
    configure: (panelId: string, allowMove: boolean) =>
      request<void>({ action: "configure", panelId, allowMove }),
    unbind: (panelId: string) => request<void>({ action: "unbind", panelId }),
    detach: (lease: PanelLease) => request<number>({ action: "detach", lease }),
    write: (lease: PanelLease, data: string) => request<void>({ action: "write", lease, data }),
    resize: (lease: PanelLease, cols: number, rows: number) =>
      request<void>({ action: "resize", lease, cols, rows }),
    async attach(lease: PanelLease, receive: (output: TerminalWindowOutput) => void) {
      check();
      let active = true;
      const release = () => {
        active = false;
        listeners.delete(release);
      };
      const output = new Channel<TerminalWindowOutput>();
      output.onmessage = (packet) => {
        if (active && !disposed) receive(packet);
      };
      listeners.add(release);
      try {
        await invoke<void>("panel_window_terminal_attach", {
          document: identity.document,
          lease,
          output,
        });
        check();
        return release;
      } catch (error) {
        release();
        throw error;
      }
    },
    dispose() {
      disposed = true;
      for (const release of listeners) release();
    },
  };
}
