import type { FrontendTerminal } from "../contracts/terminal/surface";
import type { CheckProviderAccess } from "../runtime/providers/access";
import type { createProviderLease } from "../runtime/providers/lease";

export function guardTerminalProvider(
  terminal: FrontendTerminal,
  checkAccess: CheckProviderAccess,
  lease: Pick<ReturnType<typeof createProviderLease>, "retain">,
  report: (error: unknown) => void,
): FrontendTerminal {
  return Object.freeze<FrontendTerminal>({
    Screen: terminal.Screen,
    readState: () => {
      checkAccess(false);
      return terminal.readState();
    },
    readLines: (request) => {
      checkAccess(false);
      return terminal.readLines(request);
    },
    readSelection: () => {
      checkAccess(false);
      return terminal.readSelection();
    },
    subscribe: (receive, options) => {
      checkAccess();
      if (typeof receive !== "function") throw new Error("plugin.terminal.invalid");
      let release = () => {};
      const stop = terminal.subscribe((change) => {
        try {
          // Policy can change before React commits the replacement renderer.
          checkAccess();
        } catch {
          release();
          return;
        }
        try {
          receive(change);
        } catch (error) {
          release();
          report(error);
        }
      }, options);
      release = lease.retain(() => {
        stop();
        options?.signal?.removeEventListener("abort", release);
      });
      if (options?.signal?.aborted) release();
      else options?.signal?.addEventListener("abort", release, { once: true });
      return release;
    },
    focus: () => {
      checkAccess();
      terminal.focus();
    },
    paste: (text) => {
      checkAccess();
      terminal.paste(text);
    },
    send: (text) => {
      checkAccess();
      terminal.send(text);
    },
    scrollToLine: (row) => {
      checkAccess();
      terminal.scrollToLine(row);
    },
    clearSelection: () => {
      checkAccess();
      terminal.clearSelection();
    },
  });
}
