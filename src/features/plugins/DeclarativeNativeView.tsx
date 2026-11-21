import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { copyText } from "@/lib/session/clipboard";
import { useBackgroundGuard } from "@/lib/session/viewState";
import { usePanelViewStateBridge } from "@/lib/panels/viewState";
import { normalizeBlocks, normalizeResult, type PluginBlock } from "@/lib/plugins/pluginView";
import type { DeclarativePluginView } from "@/lib/plugins/views/declarative";
import type { NativeViewProps } from "@/lib/panels/useNativeReadModel";
import type { NativeDeclarativeViewDescriptor } from "@/lib/panels/windowProtocol";
import { reportError } from "@/lib/diagnostics";
import { DeclarativePluginView as Renderer } from "./DeclarativePluginView";
import { PluginRestrictedAction } from "./PluginSecuritySection";
import { PluginChat } from "./PluginChat";
import { PluginMounts } from "./PluginMounts";
import { SharedMounts } from "./SharedMounts";
import { DeclarativeSecretDraftScope, useDeclarativeSecretDraft } from "./declarativeSecretDrafts";
import "@/styles/pluginTools.css";

function normalized(payload: unknown): DeclarativePluginView {
  const record = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  return {
    revision: crypto.randomUUID(),
    title: typeof record.title === "string" ? record.title : "",
    blocks: normalizeBlocks(record.blocks),
  };
}

/** Host-rendered JSON views use an exact native lease and a closed action
 * gateway. They never load a frontend module, clone a singleton activation or
 * expose command names from the renderer snapshot. */
export function DeclarativeNativeView({
  client,
  record,
  visible = true,
}: Pick<NativeViewProps, "client" | "record"> & { visible?: boolean }) {
  const { i18n } = useTranslation();
  const descriptor = record.declarative as NativeDeclarativeViewDescriptor | undefined;
  const native = client.declarativeViews((error) =>
    reportError("plugins.declarative.nativeView", "transport", error),
  );
  const [view, setView] = useState<DeclarativePluginView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [attached, setAttached] = useState(false);
  const session = useRef<{ pluginId: string; runtimeId: string; viewId: string } | null>(null);
  useBackgroundGuard(busy);
  useEffect(() => {
    let disposed = false;
    if (!descriptor) return;
    void (async () => {
      try {
        const opened = await native.open(record, descriptor);
        if (disposed) return;
        session.current = {
          pluginId: opened.pluginId,
          runtimeId: opened.runtimeId,
          viewId: opened.viewId,
        };
        setAttached(true);
        const payload = await native.render(record, i18n.resolvedLanguage ?? i18n.language);
        if (!disposed) setView(normalized(payload));
      } catch (cause) {
        if (!disposed) setError(String(cause));
      } finally {
        if (!disposed) setLoading(false);
      }
    })();
    return () => {
      disposed = true;
      session.current = null;
    };
  }, [descriptor, i18n.language, i18n.resolvedLanguage, native, record]);
  if (!descriptor) return null;
  return (
    <DeclarativeSecretDraftScope client={client} record={record}>
      <Renderer
        pluginId={descriptor.pluginId}
        viewId={descriptor.viewId}
        view={view}
        loading={loading}
        error={error}
        onRefresh={() => {
          setLoading(true);
          setError(null);
          void native
            .render(record, i18n.resolvedLanguage ?? i18n.language)
            .then((payload) => setView(normalized(payload)))
            .catch((cause) => setError(String(cause)))
            .finally(() => setLoading(false));
        }}
        services={{
          useViewState: usePanelViewStateBridge,
          useSecretState: useDeclarativeSecretDraft,
          useBusyGuard: (value) => {
            useBackgroundGuard(value);
          },
          run: async (request, signal) => {
            const current = session.current;
            if (!current || !attached || request.revision !== view?.revision)
              throw new Error("plugin.invocation.cancelled");
            const block = view.blocks.find(
              (item): item is Extract<PluginBlock, { type: "form" }> =>
                item.type === "form" && item.id === request.formId,
            );
            const action = block?.actions.find((item) => item.id === request.actionId);
            if (!action) throw new Error("plugin.frontend.commandUnavailable");
            if (signal?.aborted) throw new Error("plugin.invocation.cancelled");
            setBusy(true);
            try {
              const response = await native.run(record, action.command, request.values);
              return normalizeResult(response);
            } finally {
              setBusy(false);
            }
          },
        }}
        reportFailure={(cause) => setError(String(cause))}
        errorAction={<PluginRestrictedAction />}
        copyResult={copyText}
        renderDomainBlock={(block) => {
          if (block.type === "mounts") return <PluginMounts pluginId={descriptor.pluginId} />;
          if (block.type === "sharedMounts")
            return (
              <SharedMounts
                pluginId={descriptor.pluginId}
                viewId={descriptor.viewId}
                visible={visible}
              />
            );
          if (block.type === "chat")
            return (
              <PluginChat
                pluginId={descriptor.pluginId}
                viewId={descriptor.viewId}
                block={block}
                visible={visible}
              />
            );
          throw new Error("plugin.frontend.viewUnavailable");
        }}
      />
    </DeclarativeSecretDraftScope>
  );
}
