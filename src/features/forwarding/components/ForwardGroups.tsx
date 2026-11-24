import { useForwardingCaptureGuard } from "../runtime/useForwardingCaptureGuard";
import { useState } from "react";
import { presentError } from "@/lib/api/errors";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/form/Button";
import { Menu } from "@/components/ui/overlay/Menu";
import type { ForwardGroup } from "../model/contract";
import type { ForwardingController } from "../runtime/useForwardingController";
import { ForwardingEntries } from "./ForwardingEntries";

export function ForwardGroups({
  controller,
  hostId,
  onEditGroup,
}: {
  controller: ForwardingController;
  hostId: string;
  onEditGroup: (group: ForwardGroup) => void;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  useForwardingCaptureGuard("groups-admission", () => busy);
  const [error, setError] = useState<string | null>(null);
  const run = async (operation: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await operation();
    } catch (cause) {
      setError(presentError(cause));
    } finally {
      setBusy(false);
      controller.actions.refresh();
    }
  };
  const groups = [
    ...controller.groups,
    { id: "", name: t("forward.ungrouped"), hostId, revision: "" },
  ];
  return (
    <div className="forward-groups">
      {groups.map((group) => {
        const rules = controller.rules.filter((rule) => (rule.groupId ?? "") === group.id);
        if (!group.id && !rules.length) return null;
        return (
          <section className="forward-group" key={group.id} aria-label={group.name}>
            <header className="forward-group__head">
              <h3 className="forward-group__title">{group.name}</h3>
              <div className="forwarding__tools">
                {group.id && (
                  <Button
                    size="sm"
                    aria-label={t("forward.startGroup", { name: group.name })}
                    disabled={busy || controller.busy || !rules.some(controller.canStart)}
                    onClick={() =>
                      controller.start(rules.filter(controller.canStart).map((rule) => rule.id))
                    }
                  >
                    {t("forward.startAll")}
                  </Button>
                )}
                {group.id && (
                  <Menu
                    label={t("common.more")}
                    disabled={controller.busy}
                    items={[
                      {
                        label: t("menu.rename"),
                        onSelect: () => {
                          setError(null);
                          onEditGroup(group);
                        },
                      },
                      {
                        label: t("common.delete"),
                        danger: true,
                        disabled: !!rules.length,
                        description: rules.length ? t("forward.groupNotEmpty") : undefined,
                        onSelect: () => void run(() => controller.actions.removeGroup(group)),
                      },
                    ]}
                  />
                )}
              </div>
            </header>
            {!!rules.length && <ForwardingEntries {...controller} rules={rules} />}
          </section>
        );
      })}
      {!controller.rules.length && <p className="forwarding__empty">{t("forward.noRules")}</p>}
      {error && (
        <p role="alert" className="td-field__error">
          {error}
        </p>
      )}
    </div>
  );
}
