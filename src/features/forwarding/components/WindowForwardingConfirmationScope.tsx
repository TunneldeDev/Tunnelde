import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ConfirmDialog } from "@/components/ui/overlay/ConfirmDialog";
import { Dialog } from "@/components/ui/overlay/Dialog";
import { Button } from "@/components/ui/form/Button";
import { translateError } from "@/lib/api/errors";
import type { PanelWindowClient } from "@/lib/panels/windowClient";
import type { PanelLease } from "@/lib/panels/windowProtocol";
import { createPanelWindowInteraction } from "@/lib/panels/windowInteraction";
import { toast } from "@/store/toasts";
import {
  ForwardingConfirmationScope,
  type ForwardingConfirmation,
  type ForwardingConfirm,
} from "../runtime/confirmationScope";
import { useForwardingCaptureGuard } from "../runtime/useForwardingCaptureGuard";

type Props = { client: PanelWindowClient; lease?: PanelLease; children: ReactNode };
type Entry = {
  scope: ReturnType<typeof createPanelWindowInteraction>;
  options: ForwardingConfirmation;
  run: (id: string) => Promise<void>;
  owner: object;
};
/** Every confirmation stays inside its original native document. Nothing here
 * enters shared dialogs, layout drafts, read models or plugin messages. */
export function WindowForwardingConfirmationScope(props: Props) {
  return <OriginalScope {...props} />;
}
function OriginalScope({ client, lease, children }: Props) {
  const { t } = useTranslation();
  const panelId = lease?.panelId,
    windowId = lease?.windowId,
    generation = lease?.generation;
  const binding = useMemo(
    () =>
      panelId && windowId && generation !== undefined ? { panelId, windowId, generation } : null,
    [panelId, windowId, generation],
  );
  const [view, setView] = useState<{ entry: Entry; id?: string; error?: string } | null>(null);
  const current = useRef<Entry | null>(null);
  const owner = useMemo(() => ({ client, binding }), [client, binding]);
  useForwardingCaptureGuard("native-confirmation", () => view?.entry.owner === owner);
  const live = useRef<object | null>(null);
  const closeEntry = (entry: Entry) => {
    void entry.scope.close().catch((cause) => toast(translateError(cause), "error"));
  };
  useLayoutEffect(() => {
    live.current = owner;
    return () => {
      live.current = null;
      const entry = current.current;
      current.current = null;
      if (entry) closeEntry(entry);
    };
  }, [owner]);
  const confirm = useMemo<ForwardingConfirm>(
    () => (options) => {
      if (live.current !== owner) throw new Error("panel.window.disposed");
      if (!binding) throw new Error("panel.window.staleOwner");
      // A second request cannot replace/borrow consent from an already visible
      // dialog or silently discard an acquisition still pending in native code.
      if (current.current) return;
      let running = false;
      const captured = { ...options };
      const entry: Entry = {
        scope: createPanelWindowInteraction(client, binding),
        options: captured,
        run: async (id) => {
          entry.scope.check();
          if (live.current !== owner || current.current !== entry || running)
            throw new Error("panel.window.disposed");
          running = true;
          try {
            await captured.onConfirm(id);
            entry.scope.check();
          } finally {
            running = false;
          }
        },
        owner,
      };
      current.current = entry;
      setView({ entry });
      void entry.scope.acquired
        .then((id) => {
          entry.scope.check();
          if (live.current === owner && current.current === entry) setView({ entry, id });
        })
        .catch((cause) => {
          if (live.current === owner && current.current === entry)
            setView({ entry, error: translateError(cause) });
          closeEntry(entry);
        });
    },
    [client, binding, owner],
  );
  const close = (entry: Entry) => {
    if (current.current !== entry) return;
    current.current = null;
    setView(null);
    closeEntry(entry);
  };
  const entry = view?.entry.owner === owner ? view.entry : null;
  const id = view?.id;
  const error = view?.error;
  return (
    <ForwardingConfirmationScope value={confirm}>
      {children}
      {entry &&
        (id ? (
          <ConfirmDialog
            key={id}
            {...entry.options}
            onClose={() => close(entry)}
            onConfirm={() => entry.run(id)}
          />
        ) : (
          <Dialog
            open
            title={entry.options.title}
            closeLabel={t("common.close")}
            onClose={() => close(entry)}
            width={400}
            footer={
              <Button variant="ghost" onClick={() => close(entry)}>
                {t("common.cancel")}
              </Button>
            }
          >
            {error ? <p role="alert">{error}</p> : <p role="status">{t("common.loading")}</p>}
          </Dialog>
        ))}
    </ForwardingConfirmationScope>
  );
}
