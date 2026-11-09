import { Component, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/form/Button";
import { useSettings } from "@/store/settings";
import { usePlugins } from "@/store/plugins";
import { hasPluginGrant, usePluginSecurity } from "@/store/pluginSecurity";
import { isTauri } from "@/lib/api/ipc";
import { frontendRuntime } from "@/lib/extensions/frontendRuntime";
import { selectedUiProvider } from "@/lib/extensions/providers";
import type {
  FrontendProviderTarget,
  FrontendWorkbenchSlots,
} from "@/lib/extensions/uiSdkContract";
import { reportError } from "@/lib/diagnostics";
import { translateError } from "@/lib/api/errors";

class ProviderBoundary extends Component<
  {
    children: ReactNode;
    onFailure: (error: Error) => void;
  },
  { failed: boolean }
> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override componentDidCatch(error: Error) {
    this.props.onFailure(error);
  }
  override render() {
    return this.state.failed ? null : this.props.children;
  }
}

/** Selection never starts an unapproved plugin implicitly. Built-in surfaces remain alive. */
export function ProviderSurface({
  target,
  children,
  slots,
  validate,
  subscribe,
  visible = true,
  keepFallback = false,
}: {
  target: FrontendProviderTarget;
  children: ReactNode;
  slots?: FrontendWorkbenchSlots;
  validate?: () => boolean;
  subscribe?: (receive: () => void) => () => void;
  visible?: boolean;
  keepFallback?: boolean;
}) {
  const { t } = useTranslation();
  const selections = useSettings((state) => state.settings.uiProviders);
  const plugins = usePlugins((state) => state.items);
  const security = usePluginSecurity((state) => state.state);
  useSyncExternalStore(frontendRuntime.subscribe, frontendRuntime.revision);
  const selected = selectedUiProvider(plugins, selections, target);
  const token = selected && frontendRuntime.token(selected.plugin.id);
  const identity = selected
    ? `${selected.plugin.id}:${selected.view.id}:${selected.plugin.fingerprint ?? ""}`
    : "";
  const selection = selections?.[target];
  const [failure, setFailure] = useState<{
    identity: string;
    error: unknown;
  } | null>(null);
  const available =
    !security.restricted &&
    selected?.plugin.status === "running" &&
    (!isTauri() || hasPluginGrant(security, selected.plugin));
  const failed = failure?.identity === identity;
  // A user restore clears this local failure latch. Unrelated settings updates
  // must not retry the same broken module, even if they clone the selection DTO.
  if (!selection && failure) setFailure(null);
  const View =
    available && !failed
      ? frontendRuntime.view(selected.plugin.id, selected.view.id, selected.plugin.fingerprint)
      : undefined;
  const fail = (error: unknown) => {
    if (!selected) return;
    reportError(`plugins.${selected.plugin.id}.frontend`, `provider.${target}`, error);
    setFailure((previous) => (previous?.identity === identity ? previous : { identity, error }));
  };
  useEffect(() => {
    let cancelled = false;
    if (available && !failed && !View) {
      void frontendRuntime
        .ensure(selected.plugin)
        .then(() => {
          if (!cancelled && !frontendRuntime.view(selected.plugin.id, selected.view.id))
            fail(new Error("plugin.frontend.viewUnavailable"));
        })
        .catch((error) => {
          if (!cancelled) fail(error);
        });
    }
    return () => {
      cancelled = true;
    };
    // A module token changes once after open; re-check the currently selected generation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [available, identity, failed, View, token, selection]);
  useEffect(() => {
    if (!View || !validate) return;
    const check = () => {
      if (!validate()) fail(new Error("plugin.frontend.missingWorkspace"));
    };
    check();
    // Observe mount ownership, never terminal/editor DOM mutations at output frequency.
    return subscribe?.(check);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [View, identity, validate, subscribe]);
  const reset = () => {
    const next = { ...useSettings.getState().settings.uiProviders };
    delete next[target];
    void useSettings.getState().update({ uiProviders: next });
  };
  const active = !!View;
  return (
    <>
      {selections?.[target] ? (
        <div className="provider-recovery" role={failed ? "alert" : "status"}>
          <span>
            {active
              ? `${selected!.plugin.name} · ${selected!.view.title}`
              : t("providers.fallback")}
          </span>
          {failed ? (
            <span title={translateError(failure.error)}>{translateError(failure.error)}</span>
          ) : null}
          <Button size="sm" variant="ghost" onClick={reset}>
            {t("providers.restore")}
          </Button>
        </div>
      ) : null}
      {!active || keepFallback ? (
        <div className="provider-content" hidden={active}>
          {children}
        </div>
      ) : null}
      {active ? (
        <div className="provider-content">
          <ProviderBoundary key={`${identity}:${token}`} onFailure={fail}>
            {/* eslint-disable-next-line react-hooks/static-components */}
            <View
              pluginId={selected!.plugin.id}
              viewId={selected!.view.id}
              visible={visible}
              workbench={slots}
            />
          </ProviderBoundary>
        </div>
      ) : null}
    </>
  );
}
