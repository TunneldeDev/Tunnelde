// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

import { Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { cn } from "@/lib/text/format";
import { useDialogs } from "@/store/dialogs";
import { useHosts } from "@/store/hosts";
import { useSettings } from "@/store/settings";
import { useUpdates } from "@/store/updates";
import { useWorkspace } from "@/store/workspace";

interface Command {
  id: string;
  title: string;
  run: () => void;
}

export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const hosts = useHosts((state) => state.hosts);
  const openPage = useWorkspace((state) => state.openPage);
  const openHost = useWorkspace((state) => state.openHost);
  const splitTab = useWorkspace((state) => state.splitTab);
  const closeTab = useWorkspace((state) => state.close);
  const activeId = useWorkspace((state) => state.activeId);
  const settings = useSettings((state) => state.settings);
  const updateSettings = useSettings((state) => state.update);
  const openHostDialog = useDialogs((state) => state.openHost);
  const openConnect = useDialogs((state) => state.openConnect);
  const checkUpdates = useUpdates((state) => state.check);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    const timer = window.setTimeout(() => {
      setQuery("");
      setIndex(0);
      inputRef.current?.focus();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [open]);

  const commands = useMemo<Command[]>(() => {
    const themeLabel =
      settings.theme === "dark"
        ? t("settings.themeDark")
        : settings.theme === "light"
          ? t("settings.themeLight")
          : t("settings.themeSystem");
    const list: Command[] = [
      { id: "host.new", title: t("sidebar.newHost"), run: () => openHostDialog() },
      { id: "page.settings", title: t("nav.settings"), run: () => openPage("settings") },
      { id: "page.welcome", title: t("nav.welcome"), run: () => openPage("welcome") },
      { id: "page.about", title: t("nav.about"), run: () => openPage("about") },
      { id: "update.check", title: t("updates.check"), run: () => void checkUpdates(true) },
      {
        id: "panel.toggle",
        title: settings.rightPanel ? t("panel.hide") : t("panel.show"),
        run: () => void updateSettings({ rightPanel: !settings.rightPanel }),
      },
      {
        id: "theme.cycle",
        title: `${t("settings.theme")}: ${themeLabel}`,
        run: () =>
          void updateSettings({
            theme: settings.theme === "dark" ? "light" : settings.theme === "light" ? "system" : "dark",
          }),
      },
      {
        id: "tab.splitRight",
        title: t("tab.splitRight"),
        run: () => activeId && splitTab(activeId, "row"),
      },
      {
        id: "tab.splitDown",
        title: t("tab.splitDown"),
        run: () => activeId && splitTab(activeId, "column"),
      },
      {
        id: "tab.close",
        title: t("tab.close"),
        run: () => activeId && closeTab(activeId),
      },
    ];

    for (const host of hosts) {
      list.push({
        id: `host.connect.${host.id}`,
        title: `${t("terminal.connect")} · ${host.name}`,
        run: () => openConnect(host),
      });
      list.push({
        id: `host.open.${host.id}`,
        title: `${t("host.open")} · ${host.name}`,
        run: () => openHost(host),
      });
    }
    return list;
  }, [
    activeId,
    checkUpdates,
    closeTab,
    hosts,
    openConnect,
    openHost,
    openHostDialog,
    openPage,
    settings.rightPanel,
    settings.theme,
    splitTab,
    t,
    updateSettings,
  ]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) {
      return commands;
    }
    return commands.filter((command) => command.title.toLowerCase().includes(needle));
  }, [commands, query]);

  if (!open) {
    return null;
  }

  const run = (command: Command | undefined) => {
    if (!command) {
      return;
    }
    onClose();
    command.run();
  };

  return (
    <div
      className="td-palette-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div className="td-palette" role="dialog" aria-modal="true" aria-label={t("palette.title")}>
        <div className="td-palette__input">
          <Search size={13} aria-hidden="true" />
          <input
            ref={inputRef}
            value={query}
            spellCheck={false}
            placeholder={t("palette.placeholder")}
            aria-label={t("palette.placeholder")}
            onChange={(event) => {
              setQuery(event.target.value);
              setIndex(0);
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                onClose();
              } else if (event.key === "ArrowDown") {
                event.preventDefault();
                setIndex((current) => Math.min(filtered.length - 1, current + 1));
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                setIndex((current) => Math.max(0, current - 1));
              } else if (event.key === "Enter") {
                event.preventDefault();
                run(filtered[index]);
              }
            }}
          />
        </div>
        <div className="td-palette__list" role="listbox" aria-label={t("palette.title")}>
          {filtered.length === 0 ? <p className="td-palette__empty">{t("palette.empty")}</p> : null}
          {filtered.map((command, position) => (
            <button
              key={command.id}
              type="button"
              role="option"
              aria-selected={position === index}
              className={cn("td-palette__item", position === index && "is-active")}
              onMouseEnter={() => setIndex(position)}
              onClick={() => run(command)}
            >
              {command.title}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
