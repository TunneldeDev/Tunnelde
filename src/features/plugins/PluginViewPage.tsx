import {
  PluginInvocationCancelled,
  isPluginInvocationCancelled,
} from "@/lib/plugins/commands/runtime";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/form/Button";
import { EmptyState } from "@/components/ui/display/Misc";
import { presentError } from "@/lib/api/errors";
import { DeclarativePluginView } from "./DeclarativePluginView";
import {
  acquireDeclarativeViewOwner,
  type DeclarativeViewOwnerLease,
} from "@/lib/plugins/views/ownerRegistry";
import type { DeclarativePluginView as RenderedView } from "@/lib/plugins/views/declarative";
import { useBackgroundGuard } from "@/lib/session/viewState";
import { usePanelViewStateBridge } from "@/lib/panels/viewState";
import { copyText } from "@/lib/session/clipboard";
import { reportPluginExecutionFailure } from "@/store/pluginSecurity";
import { PluginRestrictedAction } from "./PluginSecuritySection";
import { PluginChat } from "./PluginChat";
import { PluginMounts } from "./PluginMounts";
import { SharedMounts } from "./SharedMounts";
import { useMainDeclarativeSecretDraft } from "./declarativeSecretDrafts";
import "@/styles/pluginTools.css";
import { usePlugins } from "@/store/plugins";
import { PluginComponentView } from "./PluginComponentView";
import { useNavigation } from "@/store/navigation";
import { useWorkspace } from "@/store/workspace";

interface PluginViewPageProps {
  pluginId: string;
  viewId: string;
  embedded?: boolean;
  visible?: boolean;
}

export function PluginViewPage({
  pluginId,
  viewId,
  embedded,
  visible = true,
}: PluginViewPageProps) {
  const { t } = useTranslation();
  const plugin = usePlugins((state) => state.items.find((item) => item.id === pluginId));
  const view = plugin?.views.find((item) => item.id === viewId);
  if (view?.provider)
    return (
      <EmptyState
        title={t("providers.title")}
        body={t("providers.hint")}
        action={
          <Button
            onClick={() => {
              useNavigation.getState().selectSettings("plugins");
              useWorkspace.getState().openPage("settings");
            }}
          >
            {t("settings.title")}
          </Button>
        }
      />
    );
  if (plugin && view?.kind === "component")
    return (
      <PluginComponentView
        key={`${pluginId}:${viewId}:${plugin.fingerprint ?? ""}`}
        pluginId={pluginId}
        viewId={viewId}
        visible={visible}
      />
    );
  return (
    <PluginViewContent
      key={JSON.stringify([pluginId, viewId, plugin?.fingerprint, plugin?.runtimeId])}
      pluginId={pluginId}
      viewId={viewId}
      embedded={embedded}
      visible={visible}
    />
  );
}

function PluginViewContent({ pluginId, viewId, embedded, visible }: PluginViewPageProps) {
  const { i18n } = useTranslation();
  const running = usePlugins(
    (state) => state.items.find((item) => item.id === pluginId)?.status === "running",
  );
  const [view, setView] = useState<RenderedView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const owner = useRef<DeclarativeViewOwnerLease | null>(null);
  const requestId = useRef(0);
  const renderRequest = useRef<AbortController | null>(null);

  const load = useCallback(
    (interactive = false, restore = false) => {
      const current = ++requestId.current;
      renderRequest.current?.abort();
      const controller = new AbortController();
      renderRequest.current = controller;
      const source = owner.current?.owner;
      if (!source) return Promise.resolve();
      if (restore) {
        const displayed = source.snapshot();
        if (displayed) {
          setView(displayed);
          setLoading(false);
          return Promise.resolve();
        }
      }
      return source
        .load(i18n.resolvedLanguage ?? i18n.language, {
          interactive,
          signal: controller.signal,
        })
        .then((payload) => {
          if (current !== requestId.current) return;
          if (payload === null) return;
          setView(payload);
          setError(null);
        })
        .catch((cause: unknown) => {
          if (isPluginInvocationCancelled(cause)) return;
          reportPluginExecutionFailure(cause);
          if (current === requestId.current) setError(presentError(cause));
        })
        .finally(() => {
          if (current === requestId.current) setLoading(false);
        });
    },
    [i18n.resolvedLanguage, i18n.language],
  );

  const invalidate = useCallback(() => {
    ++requestId.current;
    renderRequest.current?.abort();
  }, []);

  useEffect(() => {
    if (!running) return;
    const source = acquireDeclarativeViewOwner(pluginId, viewId);
    owner.current = source;
    void load(false, true);
    return () => {
      invalidate();
      source.release();
      if (owner.current === source) owner.current = null;
    };
  }, [invalidate, load, pluginId, running, viewId]);

  return (
    <DeclarativePluginView
      pluginId={pluginId}
      viewId={viewId}
      embedded={embedded}
      view={view}
      loading={loading}
      error={error}
      onRefresh={() => {
        setLoading(true);
        setError(null);
        void load(true);
      }}
      services={{
        run: (request, signal) => {
          if (!owner.current) return Promise.reject(new PluginInvocationCancelled());
          return owner.current.owner.run(request, signal);
        },
        useViewState: usePanelViewStateBridge,
        useSecretState: useMainDeclarativeSecretDraft,
        useBusyGuard: useBackgroundGuard,
      }}
      reportFailure={reportPluginExecutionFailure}
      errorAction={<PluginRestrictedAction />}
      copyResult={copyText}
      renderDomainBlock={(block) => {
        if (block.type === "mounts") return <PluginMounts pluginId={pluginId} />;
        if (block.type === "sharedMounts")
          return <SharedMounts pluginId={pluginId} viewId={viewId} visible={visible} />;
        if (block.type === "chat")
          return <PluginChat pluginId={pluginId} viewId={viewId} block={block} visible={visible} />;
        throw new Error("plugin.frontend.viewUnavailable");
      }}
    />
  );
}
