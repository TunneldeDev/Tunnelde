import { useTranslation } from "react-i18next";
import { Dialog } from "@/components/ui/overlay/Dialog";
import { Button } from "@/components/ui/form/Button";
import { displayShortcut, shortcutCommands } from "@/lib/keyboard/registry";
import { useShortcutConflicts } from "@/store/shortcutConflicts";
import { usePlugins } from "@/store/plugins";
import { useNavigation } from "@/store/navigation";
import { useWorkspace } from "@/store/workspace";

export function ShortcutConflictDialog() {
  const { t } = useTranslation();
  const queue = useShortcutConflicts((state) => state.queue);
  const conflict = queue[0];
  const resolving = useShortcutConflicts((state) => state.resolving);
  const plugins = usePlugins((state) => state.items);
  if (!conflict) return null;
  const definitions = shortcutCommands(plugins);
  const incoming = definitions.find((item) => item.id === conflict.incoming);
  const existing = definitions.find((item) => item.id === conflict.existing);
  const name = (item: typeof incoming) => item?.title ?? item?.id ?? "";
  const dismiss = () => useShortcutConflicts.getState().dismiss();
  const resolve = (id: string) => void useShortcutConflicts.getState().resolve(id);
  const showSettings = () => {
    const commands = new Set(queue.flatMap((item) => [item.incoming, item.existing]));
    const ids = [
      ...new Set(
        definitions
          .filter((item) => commands.has(item.id))
          .map((item) => item.plugin?.id)
          .filter(Boolean),
      ),
    ];
    useShortcutConflicts
      .getState()
      .review(`@is:conflict${ids.length ? ` & @plugins:${ids.join(",")}` : ""}`);
    useNavigation.getState().selectSettings("shortcuts");
    useWorkspace.getState().openPage("settings");
  };
  return (
    <Dialog
      open
      title={t("shortcuts.conflictTitle")}
      closeLabel={t("common.close")}
      onClose={dismiss}
      width={560}
      footer={
        <>
          <Button onClick={dismiss}>{t("shortcuts.keepConflict")}</Button>
          <Button variant="primary" onClick={showSettings}>
            {t("shortcuts.resolveConflict")}
          </Button>
        </>
      }
    >
      <p>{t("shortcuts.conflictDescription", { key: displayShortcut(conflict.binding) })}</p>
      <div className="shortcuts-conflict-options">
        <Button disabled={resolving} onClick={() => resolve(conflict.incoming)}>
          {t("shortcuts.keepBinding", { command: name(incoming) })}
        </Button>
        <Button disabled={resolving} onClick={() => resolve(conflict.existing)}>
          {t("shortcuts.keepBinding", { command: name(existing) })}
        </Button>
      </div>
    </Dialog>
  );
}
