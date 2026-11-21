import { Keyboard, Pencil, Plus, RotateCcw, Settings2, X } from "lucide-react";
import { SearchToolbar } from "@/components/ui/layout/SearchToolbar";
import { useCallback, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ParseKeys } from "i18next";
import { Button, IconButton } from "@/components/ui/form/Button";
import { Switch } from "@/components/ui/form/Field";
import { Select } from "@/components/ui/form/Select";
import { ShortcutAdvancedDialog } from "../ShortcutAdvancedDialog";
import { shortcutRule } from "@/lib/keyboard/rules";
import { Input } from "@/components/ui/form/Field";
import type { MenuAction } from "@/components/ui/overlay/Menu";
import {
  parseShortcutQuery,
  clearShortcutFilters,
  type ShortcutFilterKey,
} from "@/lib/keyboard/query";
import {
  bindingsFor,
  displayShortcut,
  recordShortcut,
  shortcutConflict,
  shortcutFilter,
  type ShortcutCommand,
} from "@/lib/keyboard/registry";
import "@/styles/shortcuts.css";

import type { ShortcutRules } from "@/lib/keyboard/rules";
import type { ConfirmOptions } from "@/store/dialogs";
import type { SettingsControlState } from "./controlState";
import type { ShortcutSettingsChange } from "../data/shortcutMutations";
export interface KeyboardShortcutsData {
  definitions: ShortcutCommand[];
  plugins: { id: string; name: string }[];
  overrides: Record<string, string[]>;
  rules: ShortcutRules;
  showDetails: boolean;
  saving: boolean;
  query: string;
}
export interface KeyboardShortcutsServices {
  useData(): KeyboardShortcutsData;
  useViewState: SettingsControlState;
  useBusyGuard(busy: boolean): void;
  setQuery(value: string): void;
  toggleFilter(key: ShortcutFilterKey, value: string): void;
  change(change: ShortcutSettingsChange): Promise<boolean>;
  confirm(options: ConfirmOptions): void;
}
export function KeyboardShortcutsView({ services }: { services: KeyboardShortcutsServices }) {
  const { t } = useTranslation();
  const { definitions, plugins, overrides, rules, showDetails, saving, query } = services.useData();
  const { setQuery, useViewState, useBusyGuard } = services;
  const [advancedId, setAdvanced] = useViewState<string | null>(
    "settings:shortcuts:advanced",
    null,
  );
  const advanced = definitions.find((item) => item.id === advancedId);
  const [sort, setSort] = useViewState("settings:shortcuts:sort", "default");
  const [working, setWorking] = useState(false);
  useBusyGuard(working || saving);
  const change = async (command: ShortcutSettingsChange) => {
    if (working || saving) return false;
    setWorking(true);
    try {
      return await services.change(command);
    } finally {
      setWorking(false);
    }
  };
  const input = useRef<HTMLInputElement>(null);
  const [focusRequest, requestSearchFocus] = useState(0);
  useLayoutEffect(() => {
    if (focusRequest) input.current?.focus();
  }, [focusRequest]);
  const hintId = useId();
  const filters = parseShortcutQuery(query);
  const modifiedOnly = filters.states.has("modified");
  const hasFilters = !!(filters.states.size || filters.source || filters.plugins.length);
  const toggleFilter = useCallback(
    (key: ShortcutFilterKey, value: string) => {
      services.toggleFilter(key, value);
      requestSearchFocus((request) => request + 1);
    },
    [services],
  );
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
        setQuery(clearShortcutFilters(query));
        requestSearchFocus((request) => request + 1);
      },
    },
  ];
  const [editing, setEditing] = useViewState<{ id: string; index: number } | null>(
    "settings:shortcuts:editing",
    null,
  );
  const [draft, setDraft] = useViewState("settings:shortcuts:draft", "");
  const label = (item: ShortcutCommand) =>
    item.title ?? t(item.label as ParseKeys, { number: item.id.slice(-1) });
  const filtered = useMemo(() => {
    return definitions
      .filter((item) =>
        shortcutFilter(
          item,
          query,
          {
            ...overrides,
            ...Object.fromEntries(
              Object.keys(rules).map((id) => [
                id,
                bindingsFor(id, overrides, undefined, definitions),
              ]),
            ),
          },
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
      )
      .sort((a, b) =>
        sort === "priority"
          ? Math.max(
              -1000,
              ...bindingsFor(b.id, overrides, undefined, definitions).map(
                (key) => shortcutRule(b, key, rules).priority,
              ),
            ) -
            Math.max(
              -1000,
              ...bindingsFor(a.id, overrides, undefined, definitions).map(
                (key) => shortcutRule(a, key, rules).priority,
              ),
            )
          : 0,
      );
  }, [query, overrides, rules, sort, t, definitions]);
  const conflict =
    editing && draft ? shortcutConflict(editing.id, draft, overrides, definitions) : undefined;
  const resetOne = async (id: string) => {
    if (await change({ kind: "reset", id })) setEditing(null);
  };
  const begin = (id: string, index: number) => {
    setEditing({ id, index });
    setDraft("");
  };
  const save = async () => {
    if (!editing || !draft) return;
    const previous =
      bindingsFor(editing.id, overrides, undefined, definitions)[editing.index] ?? null;
    if (await change({ kind: "bind", id: editing.id, previous, binding: draft })) setEditing(null);
  };
  return (
    <section className="shortcuts" aria-label={t("shortcuts.title" as ParseKeys)}>
      <p className="shortcuts__hint">{t("shortcuts.hint" as ParseKeys)}</p>
      <SearchToolbar
        className="shortcuts__toolbar"
        inputRef={input}
        value={query}
        onChange={setQuery}
        placeholder={t("shortcuts.search" as ParseKeys)}
        aria-label={t("shortcuts.search" as ParseKeys)}
        aria-describedby={hintId}
        filterItems={filterItems}
        filterLabel={t("shortcuts.filters.title")}
        actions={
          <>
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
              disabled={
                saving || working || (!Object.keys(overrides).length && !Object.keys(rules).length)
              }
              leading={<RotateCcw size={13} />}
              onClick={() =>
                services.confirm({
                  title: t("shortcuts.resetAll" as ParseKeys),
                  body: t("shortcuts.resetBody" as ParseKeys),
                  confirmLabel: t("common.reset" as ParseKeys),
                  onConfirm: () => {
                    setEditing(null);
                    void change({ kind: "reset", id: null });
                  },
                })
              }
            >
              {t("shortcuts.resetAll" as ParseKeys)}
            </Button>
          </>
        }
      />
      <div className="shortcuts__options">
        <label className="shortcuts__details-toggle">
          <Switch
            checked={showDetails}
            onChange={(value) => void change({ kind: "details", value })}
            label={t("shortcuts.advanced.show")}
          />
          <span>{t("shortcuts.advanced.show")}</span>
        </label>
        <Select
          value={sort}
          onChange={setSort}
          label={t("shortcuts.advanced.sort")}
          options={[
            { value: "default", label: t("shortcuts.advanced.sortDefault") },
            { value: "priority", label: t("shortcuts.advanced.sortPriority") },
          ]}
        />
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
                  {(Object.hasOwn(overrides, item.id) || Object.hasOwn(rules, item.id)) &&
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
                      disabled={saving || working}
                      onClick={() => {
                        void change({ kind: "remove", id: item.id, binding: key }).then((ok) => {
                          if (ok) setEditing(null);
                        });
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
                    disabled={saving || working}
                    label={`${t("shortcuts.add" as ParseKeys)}: ${label(item)}`}
                    onClick={() => begin(item.id, keys.length)}
                  >
                    <Plus size={13} />
                  </IconButton>
                )}
              </div>
              <div className="shortcuts__actions">
                <IconButton
                  size="sm"
                  label={`${t("shortcuts.advanced.title")}: ${label(item)}`}
                  onClick={() => setAdvanced(item.id)}
                >
                  <Settings2 size={14} />
                </IconButton>
                <IconButton
                  size="sm"
                  label={`${t("common.reset" as ParseKeys)}: ${label(item)}`}
                  disabled={
                    saving ||
                    working ||
                    (!Object.hasOwn(overrides, item.id) && !Object.hasOwn(rules, item.id))
                  }
                  onClick={() => resetOne(item.id)}
                >
                  <RotateCcw size={13} />
                </IconButton>
              </div>
              {showDetails && keys.length > 0 && (
                <p className="shortcuts__details">
                  {keys
                    .map((key) => {
                      const rule = shortcutRule(item, key, rules);
                      return `${displayShortcut(key)} · ${t("shortcuts.advanced.priority")} ${rule.priority} · ${t(`shortcuts.advanced.${rule.propagation}`)}`;
                    })
                    .join(" / ")}
                </p>
              )}
              {active && (
                <div className="shortcuts__recorder">
                  <Keyboard size={15} aria-hidden="true" />
                  <Input
                    autoFocus
                    readOnly
                    data-shortcut-recorder
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
                  <Button
                    size="sm"
                    variant="primary"
                    disabled={!draft || saving || working}
                    onClick={save}
                  >
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
      {advanced && (
        <ShortcutAdvancedDialog
          key={advanced.id}
          command={advanced}
          label={label(advanced)}
          bindings={bindingsFor(advanced.id, overrides, undefined, definitions)}
          rules={rules}
          saving={saving || working}
          onClose={() => setAdvanced(null)}
          useViewState={useViewState}
          onSave={(value) => change({ kind: "rules", id: advanced.id, value })}
        />
      )}
    </section>
  );
}
