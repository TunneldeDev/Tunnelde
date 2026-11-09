import { Keyboard, Pencil, Plus, RotateCcw, X } from "lucide-react";
import { SearchField } from "@/components/ui/form/SearchField";
import { useCallback, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ParseKeys } from "i18next";
import { Button, IconButton } from "@/components/ui/form/Button";
import { Input } from "@/components/ui/form/Field";
import type { MenuAction } from "@/components/ui/overlay/Menu";
import {
  parseShortcutQuery,
  toggleShortcutFilter,
  type ShortcutFilterKey,
} from "@/lib/keyboard/query";
import { useSettings } from "@/store/settings";
import { useDialogs } from "@/store/dialogs";
import {
  shortcutCommands,
  bindingsFor,
  displayShortcut,
  recordShortcut,
  shortcutConflict,
  shortcutFilter,
  type ShortcutCommand,
} from "@/lib/keyboard/registry";
import "@/styles/shortcuts.css";
import { useShortcutConflicts } from "@/store/shortcutConflicts";
import { usePlugins } from "@/store/plugins";

const EMPTY_SHORTCUTS = {};

export function KeyboardShortcuts() {
  const { t } = useTranslation();
  const plugins = usePlugins((state) => state.items);
  const definitions = useMemo(() => shortcutCommands(plugins), [plugins]);
  const overrides = useSettings((state) => state.settings.keyboardShortcuts) ?? EMPTY_SHORTCUTS;
  const update = useSettings((state) => state.update);
  const saving = useSettings((state) => state.saving);
  const query = useShortcutConflicts((state) => state.query);
  const setQuery = (value: string) => useShortcutConflicts.getState().search(value);
  const input = useRef<HTMLInputElement>(null);
  const [focusRequest, requestSearchFocus] = useState(0);
  useLayoutEffect(() => {
    if (focusRequest) input.current?.focus();
  }, [focusRequest]);
  const hintId = useId();
  const filters = parseShortcutQuery(query);
  const modifiedOnly = filters.states.has("modified");
  const hasFilters = !!(filters.states.size || filters.source || filters.plugins.length);
  const toggleFilter = useCallback((key: ShortcutFilterKey, value: string) => {
    const state = useShortcutConflicts.getState();
    state.search(toggleShortcutFilter(state.query, key, value));
    requestSearchFocus((request) => request + 1);
  }, []);
  const filterItems: MenuAction[] = [
    ...(["conflict", "modified", "unassigned"] as const).map((value) => ({
      label: t(`shortcuts.filters.${value}`),
      description: `@is:${value}`,
      checked: filters.states.has(value),
      checkable: "checkbox" as const,
      onSelect: () => toggleFilter("is", value),
    })),
    ...(["built-in", "plugin"] as const).map((value, index) => ({
      label: t(value === "plugin" ? "shortcuts.filters.plugins" : "shortcuts.filters.builtin"),
      description: `@source:${value}`,
      checked: filters.source === value,
      checkable: "radio" as const,
      separatorBefore: index === 0,
      onSelect: () => toggleFilter("source", value),
    })),
    ...plugins
      .filter((plugin) => definitions.some((item) => item.plugin?.id === plugin.id))
      .map((plugin, index) => ({
        label: plugin.name,
        description: `@plugins:${plugin.id}`,
        checked: filters.plugins.some((name) => name.toLowerCase() === plugin.id.toLowerCase()),
        checkable: "checkbox" as const,
        separatorBefore: index === 0,
        onSelect: () => toggleFilter("plugins", plugin.id),
      })),
    {
      label: t("shortcuts.filters.clear"),
      separatorBefore: true,
      disabled: !hasFilters,
      onSelect: () => {
        setQuery(filters.text);
        requestSearchFocus((request) => request + 1);
      },
    },
  ];
  const [editing, setEditing] = useState<{ id: string; index: number } | null>(null);
  const [draft, setDraft] = useState("");
  const label = (item: ShortcutCommand) =>
    item.title ?? t(item.label as ParseKeys, { number: item.id.slice(-1) });
  const filtered = useMemo(() => {
    return definitions.filter((item) =>
      shortcutFilter(
        item,
        query,
        overrides,
        definitions,
        [
          item.title ?? t(item.label as ParseKeys, { number: item.id.slice(-1) }),
          item.id,
          t(`shortcuts.scope.${item.scope}` as ParseKeys),
          ...bindingsFor(item.id, overrides, undefined, definitions).map((key) =>
            displayShortcut(key),
          ),
        ].join(" "),
      ),
    );
  }, [query, overrides, t, definitions]);
  const conflict =
    editing && draft ? shortcutConflict(editing.id, draft, overrides, definitions) : undefined;
  const resetOne = (id: string) => {
    const next = { ...overrides };
    delete next[id];
    void update({ keyboardShortcuts: next });
    setEditing(null);
  };
  const begin = (id: string, index: number) => {
    setEditing({ id, index });
    setDraft("");
  };
  const save = () => {
    if (!editing || !draft) return;
    const next = [...bindingsFor(editing.id, overrides, undefined, definitions)];
    next.splice(editing.index, editing.index < next.length ? 1 : 0, draft);
    void update({ keyboardShortcuts: { ...overrides, [editing.id]: [...new Set(next)] } });
    setEditing(null);
  };
  return (
    <section className="shortcuts" aria-label={t("shortcuts.title" as ParseKeys)}>
      <p className="shortcuts__hint">{t("shortcuts.hint" as ParseKeys)}</p>
      <div className="shortcuts__toolbar">
        <SearchField
          className="settings-search shortcuts__search"
          inputRef={input}
          value={query}
          onChange={setQuery}
          placeholder={t("shortcuts.search" as ParseKeys)}
          aria-label={t("shortcuts.search" as ParseKeys)}
          aria-describedby={hintId}
          filterItems={filterItems}
          filterLabel={t("shortcuts.filters.title")}
        />
        <label className="settings-modified-filter">
          <input
            type="checkbox"
            checked={modifiedOnly}
            onChange={() => toggleFilter("is", "modified")}
          />
          {t("shortcuts.modified" as ParseKeys)}
        </label>
        <Button
          size="sm"
          disabled={saving || !Object.keys(overrides).length}
          leading={<RotateCcw size={13} />}
          onClick={() =>
            useDialogs.getState().confirm({
              title: t("shortcuts.resetAll" as ParseKeys),
              body: t("shortcuts.resetBody" as ParseKeys),
              confirmLabel: t("common.reset" as ParseKeys),
              onConfirm: () => {
                setEditing(null);
                void update({ keyboardShortcuts: {} });
              },
            })
          }
        >
          {t("shortcuts.resetAll" as ParseKeys)}
        </Button>
      </div>
      <p className="shortcuts__filter-hint" id={hintId}>
        {t("shortcuts.filters.hint")}
      </p>
      <div className="shortcuts__list" role="list" aria-label={t("shortcuts.title" as ParseKeys)}>
        {filtered.length === 0 && (
          <p className="shortcuts__hint">{t("shortcuts.empty" as ParseKeys)}</p>
        )}
        {filtered.map((item) => {
          const keys = bindingsFor(item.id, overrides, undefined, definitions);
          const active = editing?.id === item.id;
          return (
            <div className="shortcuts__row" role="listitem" key={item.id}>
              <div className="shortcuts__command">
                <strong>{label(item)}</strong>
                <code>{item.id}</code>
                <span>
                  {t(`shortcuts.scope.${item.scope}` as ParseKeys)}
                  {Object.hasOwn(overrides, item.id) &&
                    ` · ${t("shortcuts.modified" as ParseKeys)}`}
                </span>
              </div>
              <div className="shortcuts__bindings">
                {keys.map((key, index) => (
                  <div
                    className={`shortcuts__binding${shortcutConflict(item.id, key, overrides, definitions) ? " is-conflict" : ""}`}
                    key={key}
                    title={
                      shortcutConflict(item.id, key, overrides, definitions)
                        ? t("shortcuts.conflictTitle")
                        : undefined
                    }
                  >
                    <button
                      type="button"
                      className="shortcuts__key"
                      aria-label={`${t("common.edit" as ParseKeys)}: ${label(item)} ${displayShortcut(key)}`}
                      onClick={() => begin(item.id, index)}
                    >
                      <kbd>{displayShortcut(key)}</kbd>
                      <Pencil size={11} aria-hidden="true" />
                    </button>
                    <IconButton
                      size="sm"
                      label={`${t("common.delete")}: ${label(item)} ${displayShortcut(key)}`}
                      disabled={saving}
                      onClick={() => {
                        void update({
                          keyboardShortcuts: {
                            ...overrides,
                            [item.id]: keys.filter((_, i) => i !== index),
                          },
                        });
                        setEditing(null);
                      }}
                    >
                      <X size={11} />
                    </IconButton>
                  </div>
                ))}
                {!keys.length && (
                  <span className="shortcuts__unassigned">
                    {t("shortcuts.unassigned" as ParseKeys)}
                  </span>
                )}
                {keys.length < 4 && (
                  <IconButton
                    size="sm"
                    disabled={saving}
                    label={`${t("shortcuts.add" as ParseKeys)}: ${label(item)}`}
                    onClick={() => begin(item.id, keys.length)}
                  >
                    <Plus size={13} />
                  </IconButton>
                )}
              </div>
              <IconButton
                size="sm"
                label={`${t("common.reset" as ParseKeys)}: ${label(item)}`}
                disabled={saving || !Object.hasOwn(overrides, item.id)}
                onClick={() => resetOne(item.id)}
              >
                <RotateCcw size={13} />
              </IconButton>
              {active && (
                <div className="shortcuts__recorder">
                  <Keyboard size={15} aria-hidden="true" />
                  <Input
                    autoFocus
                    readOnly
                    aria-label={t("shortcuts.record" as ParseKeys)}
                    value={draft ? displayShortcut(draft) : ""}
                    placeholder={t("shortcuts.record" as ParseKeys)}
                    onKeyDown={(event) => {
                      if (event.key === "Tab" && !event.ctrlKey && !event.metaKey && !event.altKey)
                        return;
                      event.preventDefault();
                      event.stopPropagation();
                      if (event.key === "Escape") {
                        setEditing(null);
                        return;
                      }
                      const value = recordShortcut(event.nativeEvent);
                      if (value) setDraft(value);
                    }}
                  />
                  <Button size="sm" variant="primary" disabled={!draft || saving} onClick={save}>
                    {t("common.save" as ParseKeys)}
                  </Button>
                  <Button size="sm" onClick={() => setEditing(null)}>
                    {t("common.cancel" as ParseKeys)}
                  </Button>
                  <p role={conflict ? "alert" : "status"}>
                    {conflict
                      ? t("shortcuts.conflict" as ParseKeys, { command: label(conflict) })
                      : t("shortcuts.recordHint" as ParseKeys)}
                  </p>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
