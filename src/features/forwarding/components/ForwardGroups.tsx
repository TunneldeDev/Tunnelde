import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Plus } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/form/Button";
import { Field, Input } from "@/components/ui/form/Field";
import { Dialog } from "@/components/ui/overlay/Dialog";
import { Menu } from "@/components/ui/overlay/Menu";
import { translateError } from "@/lib/api/errors";
import { forwardingStore } from "../data/store";
import type { ForwardGroup } from "../model/contract";
import type { ForwardingController } from "../runtime/useForwardingController";
import { ForwardingEntries } from "./ForwardingEntries";

export function ForwardGroups({
  controller,
  hostId,
}: {
  controller: ForwardingController;
  hostId: string;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<{ group?: ForwardGroup; name: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (operation: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await operation();
      setDraft(null);
    } catch (cause) {
      setError(translateError(cause));
    } finally {
      setBusy(false);
      forwardingStore.refresh();
    }
  };
  const groups = [
    ...controller.groups,
    { id: "", name: t("forward.ungrouped"), hostId, revision: "" },
  ];
  return (
    <div className="forward-groups">
      <div className="forwarding__group-actions">
        <Button
          size="sm"
          leading={<Plus size={13} />}
          disabled={busy || controller.busy}
          onClick={() => {
            setError(null);
            setDraft({ name: "" });
          }}
        >
          {t("forward.addGroup")}
        </Button>
        <p className="forward-help">{t("forward.groupHint")}</p>
      </div>
      {groups.map((group) => {
        const rules = controller.rules.filter((rule) => (rule.groupId ?? "") === group.id);
        if (!group.id && !rules.length) return null;
        return (
          <section className="forward-group" key={group.id} aria-label={group.name}>
            <header className="forwarding__head">
              <h3 className="forward-editor__title">{group.name}</h3>
              <div className="forwarding__tools">
                {group.id && (
                  <Button
                    size="sm"
                    aria-label={t("forward.startGroup", { name: group.name })}
                    disabled={
                      busy || controller.busy || !rules.some((rule) => !controller.isActive(rule))
                    }
                    onClick={() =>
                      controller.start(
                        rules.filter((rule) => !controller.isActive(rule)).map((rule) => rule.id),
                      )
                    }
                  >
                    {t("forward.startAll")}
                  </Button>
                )}
                {group.id && (
                  <Menu
                    label={t("common.more")}
                    disabled={busy || controller.busy}
                    items={[
                      {
                        label: t("menu.rename"),
                        onSelect: () => {
                          setError(null);
                          setDraft({ group, name: group.name });
                        },
                      },
                      {
                        label: t("common.delete"),
                        danger: true,
                        disabled: !!rules.length,
                        description: rules.length ? t("forward.groupNotEmpty") : undefined,
                        onSelect: () =>
                          void run(() =>
                            invoke("forwarding_group_remove", {
                              id: group.id,
                              expectedRevision: group.revision,
                            }),
                          ),
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
      {!draft && error && (
        <p className="td-field__error" role="alert">
          {error}
        </p>
      )}
      {draft && (
        <Dialog
          open
          title={t(draft.group ? "forward.renameGroup" : "forward.addGroup")}
          closeLabel={t("common.close")}
          onClose={() => setDraft(null)}
          dismissible={!busy}
          width={400}
          footer={
            <>
              <Button variant="ghost" disabled={busy} onClick={() => setDraft(null)}>
                {t("common.cancel")}
              </Button>
              <Button
                variant="primary"
                disabled={busy || !draft.name.trim()}
                onClick={() =>
                  void run(() =>
                    invoke("forwarding_group_save", {
                      hostId,
                      name: draft.name,
                      ...(draft.group
                        ? { id: draft.group.id, expectedRevision: draft.group.revision }
                        : {}),
                    }),
                  )
                }
              >
                {t("common.save")}
              </Button>
            </>
          }
        >
          <Field label={t("forward.groupName")}>
            <Input
              autoFocus
              maxLength={80}
              disabled={busy}
              value={draft.name}
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.nativeEvent.isComposing && draft.name.trim()) {
                  event.preventDefault();
                  void run(() =>
                    invoke("forwarding_group_save", {
                      hostId,
                      name: draft.name,
                      ...(draft.group
                        ? { id: draft.group.id, expectedRevision: draft.group.revision }
                        : {}),
                    }),
                  );
                }
              }}
            />
          </Field>
          {error && (
            <p className="td-field__error" role="alert">
              {error}
            </p>
          )}
        </Dialog>
      )}
    </div>
  );
}
