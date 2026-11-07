import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  Activity,
  Check,
  TriangleAlert,
  Info,
  RefreshCw,
  Terminal,
  Cloud,
  Code,
  Plug,
} from "lucide-react";
import i18n from "@/i18n/i18n";
import type { PluginStatusBarItem } from "@/lib/plugins/statusBar";
import { translateError } from "@/lib/api/errors";
import { toast } from "@/store/toasts";

const icons = {
  activity: Activity,
  check: Check,
  alert: TriangleAlert,
  info: Info,
  sync: RefreshCw,
  terminal: Terminal,
  cloud: Cloud,
  code: Code,
  plug: Plug,
};

export function PluginStatusItem({ item }: { item: PluginStatusBarItem }) {
  const [busy, setBusy] = useState(false);
  const Icon = item.icon ? icons[item.icon] : undefined;
  const label = `${item.pluginName}: ${item.tooltip || item.text}`;
  const content = (
    <>
      {Icon ? <Icon size={13} aria-hidden="true" /> : null}
      <span className="statusbar__item-text">{item.text}</span>
    </>
  );
  if (!item.command)
    return (
      <span className="statusbar__contribution" title={label} aria-label={label}>
        {content}
      </span>
    );
  return (
    <button
      type="button"
      className="statusbar__contribution statusbar__link"
      title={label}
      aria-label={label}
      disabled={busy}
      aria-busy={busy}
      onClick={() => {
        if (busy) return;
        setBusy(true);
        void invoke("plugin_status_bar_execute", {
          token: item.token,
          locale: i18n.resolvedLanguage ?? i18n.language,
        })
          .catch((error: unknown) => toast(`${item.pluginName}: ${translateError(error)}`, "error"))
          .finally(() => setBusy(false));
      }}
    >
      {content}
    </button>
  );
}
