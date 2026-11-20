import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ConnectionPrompt } from "@/features/connect/ConnectionPrompt";
import { Button } from "@/components/ui/form/Button";
import { Dialog } from "@/components/ui/overlay/Dialog";
import { translateError } from "@/lib/api/errors";
import type { SshSession } from "@/lib/api/types";
import type { PanelWindowClient } from "@/lib/panels/windowClient";
import type { PanelLease } from "@/lib/panels/windowProtocol";
import { toast } from "@/store/toasts";
import {
  createForwardingWindowPrompt,
  type WindowForwardingPrompt,
  type WindowForwardingPromptTarget,
} from "../runtime/windowPrompt";

interface Props {
  client: PanelWindowClient;
  lease: PanelLease;
  rule: WindowForwardingPromptTarget;
  onClose: () => void;
  onConnected: (session: SshSession) => void | Promise<void>;
  context?: ReactNode;
}
/** Origin-window UI only. The factory acquires consent before the shared
 * prompt mounts; neither its secrets nor review are checkpointed. */
export function WindowForwardingConnectDialog(props: Props) {
  const { lease, rule } = props;
  const key = JSON.stringify([
    lease.panelId,
    lease.windowId,
    lease.generation,
    rule.id,
    rule.revision,
    rule.hostId,
  ]);
  return <OriginPrompt key={key} {...props} />;
}
function OriginPrompt({ client, lease, rule, onClose, onConnected, context }: Props) {
  const { t } = useTranslation();
  // Keyed primitive identity, not a refreshed model object's identity.
  const [binding] = useState(() => ({ lease: { ...lease }, rule: { ...rule } }));
  const [result, setResult] = useState<{
    client: PanelWindowClient;
    prompt?: WindowForwardingPrompt;
    error?: string;
  } | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const active = useRef<ReturnType<typeof createForwardingWindowPrompt> | null>(null);
  const callbacks = useRef({ onClose, onConnected });
  useLayoutEffect(() => {
    callbacks.current = { onClose, onConnected };
  }, [onClose, onConnected]);
  useLayoutEffect(() => {
    let live = true;
    const scope = createForwardingWindowPrompt(client, binding.lease, binding.rule);
    active.current = scope;
    void scope.ready
      .then((prompt) => {
        if (live) setResult({ client, prompt });
      })
      .catch((cause) => {
        if (live) setResult({ client, error: translateError(cause) });
      });
    return () => {
      live = false;
      if (active.current === scope) active.current = null;
      void scope.close().catch((cause) => toast(translateError(cause), "error"));
    };
  }, [client, binding]);
  const close = () => {
    if (dismissed) return;
    const scope = active.current;
    active.current = null;
    setDismissed(true);
    // Local dismissal does not depend on native reply delivery. Cleanup and
    // original actual-effect fences continue independently after unmount.
    if (scope) void scope.close().catch((cause) => toast(translateError(cause), "error"));
    callbacks.current.onClose();
  };
  const current = result?.client === client ? result : null;
  if (dismissed) return null;
  if (current?.prompt)
    return (
      <ConnectionPrompt
        host={current.prompt.host}
        services={current.prompt.services}
        after="background"
        purpose="forwarding"
        context={context}
        onClose={close}
        onConnected={(session) => callbacks.current.onConnected(session)}
      />
    );
  return (
    <Dialog
      open
      title={t("forward.title")}
      closeLabel={t("common.close")}
      onClose={close}
      width={440}
      footer={
        <Button variant="ghost" onClick={close}>
          {t("common.cancel")}
        </Button>
      }
    >
      {current?.error ? (
        <p role="alert">{current.error}</p>
      ) : (
        <p role="status">{t("common.loading")}</p>
      )}
    </Dialog>
  );
}
