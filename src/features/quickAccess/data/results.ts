import type { TFunction, ParseKeys } from "i18next";
import type { Host, Settings, PluginInfo } from "@/lib/api/types";
import type { ShortcutCommand } from "@/lib/keyboard/registry";
import type { WorkspaceTab } from "@/store/workspace";
import { fileName, type EditorEntry } from "@/store/editors";
import type { SearchQuery } from "@/lib/search/query";
import { quickAccessCommandAction } from "../runtime/actions";
import {
  openQuickAccessHost,
  openQuickAccessTab,
  openQuickAccessMatch,
} from "../runtime/resultActions";
import { collectQuickAccessMatches } from "./matches";
import type { QuickAccessMode } from "./query";
import type { QuickAccessResult, QuickAccessCollection, SearchResult } from "./model";
export function buildQuickAccessResults({
  mode,
  definitions,
  t,
  settings,
  hosts,
  tabs,
  result,
  searchKey,
  path,
  entries,
  activeTabId,
  needle,
  sessionId,
  parsedQuery,
  plugins,
}: {
  mode: QuickAccessMode;
  definitions: ShortcutCommand[];
  t: TFunction;
  settings: Settings;
  hosts: Host[];
  tabs: WorkspaceTab[];
  result: SearchResult | null;
  searchKey: string;
  path: string | undefined;
  entries: Record<string, EditorEntry>;
  activeTabId: string | null;
  needle: string;
  sessionId: string | null;
  parsedQuery: SearchQuery;
  plugins: PluginInfo[];
}): QuickAccessCollection {
  if (mode === "commands")
    return {
      items: definitions
        .filter(
          (item) =>
            (item.scope === "workbench" ||
              (item.scope === "editor" && !!entries[activeTabId ?? ""])) &&
            item.id !== "palette.open",
        )
        .map((item) => ({
          id: item.id,
          detail: `Category: ${item.plugin ? "Plugins" : item.scope === "editor" ? "Editor" : item.id.startsWith("host.") ? "Hosts" : item.id.startsWith("sidebar.forwarding") ? "Port Forwarding" : item.id.startsWith("tab.") || item.id.startsWith("pane.") || item.id.startsWith("sidebar.") || item.id.startsWith("panel.") ? "View" : item.id.startsWith("theme.") || item.id.startsWith("font.") || item.id === "page.settings" || item.id === "keyboard.shortcuts" ? "Preferences" : "Application"}`,
          title:
            item.title ??
            (item.id === "panel.toggle"
              ? t(settings.rightPanel ? "panel.hide" : "panel.show")
              : item.id === "theme.cycle"
                ? `${t("settings.theme")}: ${t(settings.theme === "dark" ? "settings.themeDark" : settings.theme === "light" ? "settings.themeLight" : "settings.themeSystem")}`
                : t(item.label as ParseKeys, { number: item.id.slice(-1) })),
          run: quickAccessCommandAction(item, plugins, activeTabId),
        })),
      limited: false,
    };
  if (mode === "hosts")
    return {
      items: hosts.flatMap((host) => [
        {
          id: `host.connect.${host.id}`,
          title: `${t("terminal.connect")} · ${host.name}`,
          detail: `${host.username}@${host.host}`,
          run: () => openQuickAccessHost(host, true),
        },
        {
          id: `host.open.${host.id}`,
          title: `${t("host.open")} · ${host.name}`,
          run: () => openQuickAccessHost(host, false),
        },
      ]),
      limited: false,
    };
  const list: QuickAccessResult[] =
    mode === "files"
      ? tabs
          .filter((tab) => !tab.hidden)
          .map((tab) => ({
            id: `tab:${tab.id}`,
            title: tab.title,
            fileName: tab.kind === "editor" ? tab.title : undefined,
            filePath: entries[tab.id]?.path,
            detail: t("palette.openTab"),
            run: () => openQuickAccessTab(tab),
          }))
      : [];
  const { matches, limited } = collectQuickAccessMatches({
    mode,
    result,
    searchKey,
    entries,
    needle,
    sessionId,
    path,
    parsedQuery,
  });
  for (const match of matches.slice(0, 100))
    list.push({
      id: `file:${match.path}:${match.line}`,
      title: mode === "content" ? match.preview : fileName(match.path),
      fileName: fileName(match.path),
      filePath: match.path,
      detail: `${match.path}${match.line ? `:${match.line}:${match.column}` : ""}`,
      run: () => openQuickAccessMatch(match, sessionId),
    });
  return { items: list, limited };
}
