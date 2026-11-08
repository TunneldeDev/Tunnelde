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
import { useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Button, IconButton } from "@/components/ui/form/Button";
import { Select } from "@/components/ui/form/Select";
import { useTabBarContent, usePluginTabBar } from "@/store/tabBar";
import { tabBarMatches, type PluginTabBarItem, type TabBarContext } from "@/lib/plugins/tabBar";
import { orderStatusItems } from "@/lib/plugins/statusBar";
import { groupTabBarItems } from "@/lib/plugins/tabBarLayout";
import type { MenuAction } from "@/components/ui/overlay/menuTypes";
import { TabBarToolbar } from "./TabBarToolbar";
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

function PluginControl({
  item,
  busy,
  execute,
}: {
  item: PluginTabBarItem;
  busy: boolean;
  execute: (value: string | null) => void;
}) {
  const Icon = icons[item.icon as keyof typeof icons];
  const label = `${item.pluginName}: ${item.title}`;
  const tooltip = item.tooltip ? `${item.pluginName}: ${item.tooltip}` : label;
  if (item.kind === "select")
    return (
      <span title={tooltip}>
        <Select
          label={label}
          className="tabbar-contribution__select"
          value={item.value ?? ""}
          options={item.options}
          disabled={busy || item.disabled}
          onChange={(value) => execute(value)}
        />
      </span>
    );
  if (item.kind === "text")
    return (
      <span className="tabbar-contribution__text" title={tooltip}>
        {item.title}
      </span>
    );
  if (!Icon || item.showLabel)
    return (
      <Button
        variant="ghost"
        size="sm"
        aria-label={label}
        title={tooltip}
        className="tabbar-contribution__button"
        leading={Icon ? <Icon size={15} aria-hidden="true" /> : undefined}
        aria-pressed={item.checked ?? undefined}
        data-active={item.checked || undefined}
        aria-busy={busy || undefined}
        disabled={busy || item.disabled}
        onClick={() => execute(null)}
      >
        <span className="tabbar-contribution__text">{item.title}</span>
      </Button>
    );
  return (
    <IconButton
      label={label}
      title={tooltip}
      size="sm"
      active={item.checked ?? false}
      aria-pressed={item.checked ?? undefined}
      aria-busy={busy || undefined}
      disabled={busy || item.disabled}
      onClick={() => execute(null)}
    >
      <Icon size={15} aria-hidden="true" />
    </IconButton>
  );
}

export function TabBarContributions({
  context,
  placement = "trailing",
}: {
  context: TabBarContext;
  placement?: "leading" | "trailing";
}) {
  const local = useTabBarContent((state) => state.items);
  const plugins = usePluginTabBar((state) => state.items);
  const running = useRef(new Set<string>());
  const [busy, setBusy] = useState(new Set<string>());
  const execute = (item: PluginTabBarItem, value: string | null) => {
    const key = `${item.pluginId}:${item.id}`;
    if (running.current.has(key) || item.disabled) return;
    running.current.add(key);
    setBusy(new Set(running.current));
    void invoke("plugin_tab_bar_execute", {
      token: item.token,
      context,
      value,
      locale: i18n.resolvedLanguage ?? i18n.language,
    })
      .catch((error: unknown) => toast(`${item.pluginName}: ${translateError(error)}`, "error"))
      .finally(() => {
        running.current.delete(key);
        setBusy(new Set(running.current));
      });
  };
  const items = groupTabBarItems(
    orderStatusItems([
      ...local
        .filter(
          (item) => item.tabId === context.tabId && (item.placement ?? "trailing") === placement,
        )
        .map((item) => ({
          id: `core:${item.id}`,
          group: `core:${item.group ?? item.id}`,
          priority: item.priority,
          content: item.content,
          actions: item.overflowActions,
        })),
      ...plugins
        .filter(
          (item) => tabBarMatches(item, context) && (item.placement ?? "trailing") === placement,
        )
        .map((item) => {
          const disabled = item.disabled || busy.has(`${item.pluginId}:${item.id}`);
          const label = `${item.pluginName}: ${item.title}`;
          const Icon = icons[item.icon as keyof typeof icons];
          const actions: MenuAction[] =
            item.kind === "select"
              ? item.options.map((option) => ({
                  label: `${label}: ${option.label}`,
                  disabled,
                  checked: item.value === option.value,
                  checkable: "radio",
                  onSelect: () => execute(item, option.value),
                }))
              : [
                  {
                    label,
                    disabled: disabled || item.kind === "text",
                    icon: Icon ? <Icon size={15} /> : undefined,
                    checked: item.checked ?? undefined,
                    checkable: "checkbox",
                    onSelect: () => execute(item, null),
                  },
                ];
          return {
            id: `plugin:${item.pluginId}:${item.id}`,
            group: `plugin:${item.pluginId}:${item.group ?? "default"}`,
            priority: item.priority,
            actions,
            content: (
              <PluginControl
                item={item}
                busy={busy.has(`${item.pluginId}:${item.id}`)}
                execute={(value) => execute(item, value)}
              />
            ),
          };
        }),
    ]),
  );
  return items.length ? <TabBarToolbar items={items} placement={placement} /> : null;
}
