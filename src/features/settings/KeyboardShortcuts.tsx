import { Keyboard, Pencil, Plus, RotateCcw, Search, X } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ParseKeys } from "i18next";
import { Button, IconButton } from "@/components/ui/form/Button";
import { Input } from "@/components/ui/form/Field";
import { useSettings } from "@/store/settings";
import { useDialogs } from "@/store/dialogs";
import {
  shortcutCommands,
  bindingsFor,
  displayShortcut,
  recordShortcut,
  shortcutConflict,
  type ShortcutCommand,
} from "@/lib/keyboard/registry";
import "@/styles/shortcuts.css";
import { usePlugins } from "@/store/plugins";

const EMPTY_SHORTCUTS = {};

export function KeyboardShortcuts() {
  const { t } = useTranslation();
  const plugins = usePlugins((state) => state.items);
  const definitions = useMemo(() => shortcutCommands(plugins), [plugins]);
  const overrides = useSettings((state) => state.settings.keyboardShortcuts) ?? EMPTY_SHORTCUTS;
  const update = useSettings((state) => state.update);
  const saving = useSettings((state) => state.saving);
  const [query, setQuery] = useState("");
  const [modifiedOnly, setModifiedOnly] = useState(false);
  const [editing, setEditing] = useState<{ id: string; index: number } | null>(null);
  const [draft, setDraft] = useState("");
  const label = (item: ShortcutCommand) =>
    item.title ?? t(item.label as ParseKeys, { number: item.id.slice(-1) });
  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return definitions.filter(
      (item) =>
        (!modifiedOnly || Object.hasOwn(overrides, item.id)) &&
        [
          item.title ?? t(item.label as ParseKeys, { number: item.id.slice(-1) }),
          item.id,
          t(`shortcuts.scope.${item.scope}` as ParseKeys),
          ...bindingsFor(item.id, overrides, undefined, definitions).map((key) =>
            displayShortcut(key),
          ),
        ]
          .join(" ")
          .toLocaleLowerCase()
          .includes(needle),
    );
  }, [query, modifiedOnly, overrides, t, definitions]);
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
    if (!editing || !draft || conflict) return;
    const next = [...bindingsFor(editing.id, overrides, undefined, definitions)];
    next.splice(editing.index, editing.index < next.length ? 1 : 0, draft);
    void update({ keyboardShortcuts: { ...overrides, [editing.id]: [...new Set(next)] } });
    setEditing(null);
  };
  return (
    <section className="shortcuts" aria-label={t("shortcuts.title" as ParseKeys)}>
      <p className="shortcuts__hint">{t("shortcuts.hint" as ParseKeys)}</p>
      <div className="shortcuts__toolbar">
        <label className="settings-search">
          <Search size={14} aria-hidden="true" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("shortcuts.search" as ParseKeys)}
            aria-label={t("shortcuts.search" as ParseKeys)}
          />
          {query && (
            <IconButton size="sm" label={t("common.close")} onClick={() => setQuery("")}>
              <X size={13} />
            </IconButton>
          )}
        </label>
        <label className="settings-modified-filter">
          <input
            type="checkbox"
            checked={modifiedOnly}
            onChange={(event) => setModifiedOnly(event.target.checked)}
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
                  <div className="shortcuts__binding" key={key}>
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
                  <Button
                    size="sm"
                    variant="primary"
                    disabled={!draft || !!conflict || saving}
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
    </section>
  );
}
