import { Search } from "lucide-react";
import "@/styles/shortcuts.css";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ParseKeys } from "i18next";
import { runWorkbenchCommand } from "@/lib/keyboard/actions";
import { SHORTCUT_COMMANDS, bindingsFor, displayShortcut } from "@/lib/keyboard/registry";

import { cn } from "@/lib/text/format";
import { useDialogs } from "@/store/dialogs";
import { useHosts } from "@/store/hosts";
import { useSettings } from "@/store/settings";
import { useWorkspace } from "@/store/workspace";

interface Command {
  id: string;
  title: string;
  run: () => void;
}

export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const hosts = useHosts((state) => state.hosts);
  const openHost = useWorkspace((state) => state.openHost);
  const settings = useSettings((state) => state.settings);
  const openConnect = useDialogs((state) => state.openConnect);
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
    const list: Command[] = SHORTCUT_COMMANDS.filter(
      (item) => item.scope === "workbench" && item.id !== "palette.open",
    ).map((item) => ({
      id: item.id,
      title:
        item.id === "panel.toggle"
          ? t(settings.rightPanel ? "panel.hide" : "panel.show")
          : item.id === "theme.cycle"
            ? `${t("settings.theme")}: ${themeLabel}`
            : t(item.label as ParseKeys, { number: item.id.slice(-1) }),
      run: () => {
        runWorkbenchCommand(item.id);
      },
    }));

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
  }, [hosts, openConnect, openHost, settings.rightPanel, settings.theme, t]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) {
      return commands;
    }
    return commands.filter((command) =>
      `${command.title} ${command.id} ${bindingsFor(command.id, settings.keyboardShortcuts)
        .map((key) => displayShortcut(key))
        .join(" ")}`
        .toLowerCase()
        .includes(needle),
    );
  }, [commands, query, settings.keyboardShortcuts]);

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
              <span>{command.title}</span>
              {bindingsFor(command.id, settings.keyboardShortcuts)[0] && (
                <kbd aria-hidden="true" className="td-palette__shortcut">
                  {displayShortcut(bindingsFor(command.id, settings.keyboardShortcuts)[0]!)}
                </kbd>
              )}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
