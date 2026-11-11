import { Component, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/form/Button";
import { frontendRuntime } from "@/lib/extensions/frontendRuntime";
import { PluginRuntimeView } from "@/lib/extensions/runtime/views/PluginRuntimeView";
import { translateError } from "@/lib/api/errors";
import { reportError } from "@/lib/diagnostics";
import { usePlugins } from "@/store/plugins";
import { usePluginSecurity } from "@/store/pluginSecurity";
import { PluginRestrictedAction } from "./PluginSecuritySection";

class ViewBoundary extends Component<
  { children: ReactNode; pluginId: string; fallback: (error: Error) => ReactNode },
  { error: Error | null }
> {
  override state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  override componentDidCatch(error: Error) {
    reportError(`plugins.${this.props.pluginId}.frontend`, "render", error);
  }
  override render() {
    return this.state.error ? this.props.fallback(this.state.error) : this.props.children;
  }
}

export function PluginComponentView({
  pluginId,
  viewId,
  visible = true,
}: {
  pluginId: string;
  viewId: string;
  visible?: boolean;
}) {
  const { t } = useTranslation();
  const plugin = usePlugins((state) => state.items.find((item) => item.id === pluginId));
  const restricted = usePluginSecurity((state) => state.state.restricted);
  useSyncExternalStore(frontendRuntime.subscribe, frontendRuntime.revision);
  const token = frontendRuntime.token(pluginId);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    let cancelled = false;
    if (!plugin || restricted || error || plugin.status !== "running") return;
    void frontendRuntime
      .ensure(plugin)
      .then(() => {
        if (!frontendRuntime.view(pluginId, viewId))
          throw new Error("plugin.frontend.viewUnavailable");
      })
      .catch((cause) => {
        if (!cancelled) setError(cause);
      });
    return () => {
      cancelled = true;
    };
  }, [plugin, pluginId, viewId, restricted, token, error]);
  const View = frontendRuntime.view(pluginId, viewId);
  const retry = (
    <Button
      onClick={() => {
        setError(null);
        frontendRuntime.stop(pluginId);
        void usePlugins.getState().start(pluginId);
      }}
    >
      {t("pluginView.refresh")}
    </Button>
  );
  const fallback = (cause: unknown) => (
    <div role="alert" className="panel__error">
      {translateError(cause)}
      {retry}
    </div>
  );
  return (
    <div className="plugin-view plugin-view--component">
      {restricted ? (
        <PluginRestrictedAction />
      ) : error ? (
        fallback(error)
      ) : View ? (
        <ViewBoundary
          key={`${pluginId}:${viewId}:${token ?? "none"}`}
          pluginId={pluginId}
          fallback={fallback}
        >
          <PluginRuntimeView
            View={View}
            viewProps={{ pluginId, viewId, visible }}
            token={token}
            fingerprint={plugin?.fingerprint}
            onFailure={setError}
          />
        </ViewBoundary>
      ) : (
        <p role="status">
          {t(plugin?.status === "running" ? "common.loading" : "pluginView.empty")}
        </p>
      )}
      {!restricted && !error && !View && retry}
    </div>
  );
}
