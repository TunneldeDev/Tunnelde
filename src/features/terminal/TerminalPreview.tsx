import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

import { useSettings } from "@/store/settings";
import {
  bindTerminalSettings,
  terminalOptions,
  waitForCurrentTerminalFont,
} from "./terminalRuntime";

const SAMPLE = [
  "\x1b[?25h\x1b[32muser@tunnelde\x1b[0m:\x1b[34m~\x1b[0m$ ls",
  "\x1b[34mprojects/\x1b[0m  README.md  \x1b[32mdeploy.sh\x1b[0m",
  "\x1b[33m●\x1b[0m  \x1b[31m●\x1b[0m  \x1b[35m●\x1b[0m  \x1b[36m●\x1b[0m  0123456789",
  "┌────────────────────────┐",
  "│ Tunnelde               │",
  "│ 中文  ①  ❌ ✅ 👩‍💻      │",
  "└────────────────────────┘",
  "\x1b[32muser@tunnelde\x1b[0m:\x1b[34m~\x1b[0m$ ",
].join("\r\n");

/** A local, read-only terminal: no SSH session, history, or network requests. */
export function TerminalPreview({ className = "" }: { className?: string }) {
  const { t } = useTranslation();
  const container = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    let disposed = false;
    let terminal: Terminal | null = null;
    let runtime: ReturnType<typeof bindTerminalSettings> | null = null;
    const observer = new ResizeObserver(() => runtime?.requestLayout());
    observer.observe(element);
    void (async () => {
      await waitForCurrentTerminalFont(() => disposed);
      if (disposed) return;
      terminal = new Terminal({
        ...terminalOptions(useSettings.getState().settings),
        disableStdin: true,
      });
      const fit = new FitAddon();
      terminal.loadAddon(fit);
      terminal.open(element);
      terminalRef.current = terminal;
      runtime = bindTerminalSettings(terminal, () => {
        if (element.clientWidth > 24 && element.clientHeight > 24) fit.fit();
      });
      runtime.requestLayout();
      terminal.write(SAMPLE);
    })();
    return () => {
      disposed = true;
      observer.disconnect();
      runtime?.dispose();
      terminal?.dispose();
      terminalRef.current = null;
    };
  }, []);
  return (
    <div
      ref={container}
      className={`terminal-preview terminal-host ${className}`.trim()}
      style={{ height: 180, minHeight: 180, overflow: "hidden" }}
      aria-label={t("terminal.previewLabel")}
      onClick={() => terminalRef.current?.focus()}
    />
  );
}
