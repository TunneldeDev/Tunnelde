import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Dialog } from "@/components/ui/overlay/Dialog";
import { Button } from "@/components/ui/form/Button";
import { Field, Input } from "@/components/ui/form/Field";
import { Select } from "@/components/ui/form/Select";
import { displayShortcut, type ShortcutCommand } from "@/lib/keyboard/registry";
import { shortcutRule, type ShortcutRules, type ShortcutPropagation } from "@/lib/keyboard/routing";

export function ShortcutAdvancedDialog({
  command,
  label,
  bindings,
  rules,
  saving,
  onSave,
  onClose,
}: {
  command: ShortcutCommand;
  label: string;
  bindings: string[];
  rules: ShortcutRules;
  saving: boolean;
  onSave: (rules: ShortcutRules[string]) => Promise<boolean>;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(() =>
    Object.fromEntries(
      bindings.map((key) => [
        key,
        {
          ...shortcutRule(command, key, rules),
          priority: String(shortcutRule(command, key, rules).priority),
        },
      ]),
    ),
  );
  const valid = Object.values(draft).every(
    (rule) =>
      /^-?\d+$/.test(rule.priority) &&
      Number(rule.priority) >= -1000 &&
      Number(rule.priority) <= 1000,
  );
  const save = async (reset = false) => {
    if (
      await onSave(
        reset
          ? {}
          : Object.fromEntries(
              Object.entries(draft).map(([key, rule]) => [
                key,
                { ...rule, priority: Number(rule.priority) },
              ]),
            ),
      )
    )
      onClose();
  };
  return (
    <Dialog
      open
      title={t("shortcuts.advanced.title")}
      closeLabel={t("common.close")}
      onClose={onClose}
      width={520}
      footer={
        <>
          <Button disabled={saving} onClick={() => void save(true)}>
            {t("common.reset")}
          </Button>
          <Button disabled={saving} onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button variant="primary" disabled={saving || !valid} onClick={() => void save()}>
            {t("common.save")}
          </Button>
        </>
      }
    >
      <div className="shortcuts-advanced">
        <div className="shortcuts-advanced__heading">
          <strong>{label}</strong>
          <code>{command.id}</code>
        </div>
        <p className="shortcuts__hint">{t("shortcuts.advanced.hint")}</p>
        {bindings.map((key, index) => (
          <fieldset key={key} disabled={saving} className="shortcuts-advanced__binding">
            <legend>
              <kbd>{displayShortcut(key)}</kbd>
            </legend>
            <Field
              htmlFor={`shortcut-priority-${index}`}
              label={t("shortcuts.advanced.priority")}
              error={
                !/^-?\d+$/.test(draft[key]!.priority) ||
                Math.abs(Number(draft[key]!.priority)) > 1000
                  ? t("shortcuts.advanced.invalidPriority")
                  : null
              }
            >
              <Input
                id={`shortcut-priority-${index}`}
                type="number"
                min={-1000}
                max={1000}
                step={1}
                value={draft[key]!.priority}
                onChange={(event) =>
                  setDraft({ ...draft, [key]: { ...draft[key]!, priority: event.target.value } })
                }
              />
            </Field>
            <Field
              label={t("shortcuts.advanced.propagation")}
              hint={t(`shortcuts.advanced.${draft[key]!.propagation}Hint`)}
            >
              <Select
                label={`${t("shortcuts.advanced.propagation")} ${displayShortcut(key)}`}
                value={draft[key]!.propagation}
                options={(["consume", "continue", "block"] as const).map((value) => ({
                  value,
                  label: t(`shortcuts.advanced.${value}`),
                }))}
                onChange={(value) =>
                  setDraft({
                    ...draft,
                    [key]: { ...draft[key]!, propagation: value as ShortcutPropagation },
                  })
                }
              />
            </Field>
            <p className="shortcuts-advanced__priority-hint">
              {t("shortcuts.advanced.priorityHint")}
            </p>
          </fieldset>
        ))}
        {!bindings.length && (
          <p className="shortcuts__hint">{t("shortcuts.advanced.unassigned")}</p>
        )}
        <p className="shortcuts__hint">{t("shortcuts.advanced.acceptance")}</p>
      </div>
    </Dialog>
  );
}
