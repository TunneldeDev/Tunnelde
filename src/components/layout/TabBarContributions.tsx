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
  Copy,
  Trash2,
  FolderOpen,
  FileText,
  WrapText,
  ArrowDownToLine,
  Play,
  Pause,
  ListFilter,
} from "lucide-react";
import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Button, IconButton } from "@/components/ui/form/Button";
import { Select } from "@/components/ui/form/Select";
import { useTabBarContent, usePluginTabBar } from "@/store/tabBar";
import { tabBarMatches, type PluginTabBarItem, type TabBarContext } from "@/lib/plugins/tabBar";
import { orderStatusItems } from "@/lib/plugins/statusBar";
import { translateError } from "@/lib/api/errors";
import i18n from "@/i18n/i18n";
import { toast } from "@/store/toasts";
import "./tabBar.css";

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
  copy: Copy,
  clear: Trash2,
  folder: FolderOpen,
  file: FileText,
  wrap: WrapText,
  follow: ArrowDownToLine,
  play: Play,
  pause: Pause,
  filter: ListFilter,
};

function PluginControl({ item, context }: { item: PluginTabBarItem; context: TabBarContext }) {
  const [busy, setBusy] = useState(false);
  const Icon = icons[item.icon as keyof typeof icons];
  const label = `${item.pluginName}: ${item.title}`;
  const execute = (value: string | null) => {
    if (busy || item.disabled) return;
    setBusy(true);
    void invoke("plugin_tab_bar_execute", {
      token: item.token,
      context,
      value,
      locale: i18n.resolvedLanguage ?? i18n.language,
    })
      .catch((error: unknown) => toast(`${item.pluginName}: ${translateError(error)}`, "error"))
      .finally(() => setBusy(false));
  };
  if (item.kind === "select")
    return (
      <Select
        label={label}
        className="tabbar-contribution__select"
        value={item.value ?? ""}
        options={item.options}
        disabled={busy || item.disabled}
        onChange={(value) => execute(value)}
      />
    );
  if (item.kind === "text")
    return (
      <span className="tabbar-contribution__text" title={label}>
        {item.title}
      </span>
    );
  if (!Icon)
    return (
      <Button
        variant="ghost"
        size="sm"
        aria-label={label}
        disabled={busy || item.disabled}
        onClick={() => execute(null)}
      >
        <span className="tabbar-contribution__text">{item.title}</span>
      </Button>
    );
  return (
    <IconButton
      label={label}
      size="sm"
      disabled={busy || item.disabled}
      onClick={() => execute(null)}
    >
      <Icon size={14} />
    </IconButton>
  );
}

export function TabBarContributions({ context }: { context: TabBarContext }) {
  const local = useTabBarContent((state) => state.items);
  const plugins = usePluginTabBar((state) => state.items);
  const items = orderStatusItems([
    ...local
      .filter((item) => item.tabId === context.tabId)
      .map((item) => ({ id: `core:${item.id}`, priority: item.priority, content: item.content })),
    ...plugins
      .filter((item) => tabBarMatches(item, context))
      .map((item) => ({
        id: `plugin:${item.pluginId}:${item.id}`,
        priority: item.priority,
        content: <PluginControl key={item.token} item={item} context={context} />,
      })),
  ]);
  return items.length ? (
    <div className="tabbar-contributions">
      {items.map((item) => (
        <div className="tabbar-contribution" key={item.id}>
          {item.content}
        </div>
      ))}
    </div>
  ) : null;
}
