import {
  Component,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/form/Button";
import { useSettings } from "@/store/settings";
import { usePlugins } from "@/store/plugins";
import { hasPluginGrant, usePluginSecurity } from "@/store/pluginSecurity";
import { isTauri } from "@/lib/api/ipc";
import { frontendRuntime } from "@/lib/extensions/frontendRuntime";
import { selectedUiProvider } from "@/lib/extensions/providers";
import type { FrontendProviderTarget } from "@/lib/extensions/contracts/frontend/providers";
import type { FrontendWorkbenchSlots } from "@/lib/extensions/contracts/workbench/slots";
import type { FrontendFileBrowser } from "@/lib/extensions/contracts/files/browser";
import type { FrontendTerminal } from "@/lib/extensions/contracts/terminal/surface";
import type { FrontendHistory } from "@/lib/extensions/contracts/history/provider";
import { reportError } from "@/lib/diagnostics";
import { translateError } from "@/lib/api/errors";
import type { HistoryContext } from "@/lib/extensions/history/context";

import { createProviderLease } from "@/lib/extensions/runtime/providers/lease";
import { guardFileBrowserProvider } from "@/lib/extensions/files/provider";
import { guardTerminalProvider } from "@/lib/extensions/terminal/provider";
import { guardHistoryProvider } from "@/lib/extensions/history/provider";

import type { FrontendForwarding } from "@/lib/extensions/contracts/forwarding/provider";
import type { ForwardingContext } from "@/lib/extensions/forwarding/context";
import { useForwardingProvider } from "@/lib/extensions/forwarding/useProvider";
import type { FrontendMonitor } from "@/lib/extensions/contracts/monitor/provider";
import type { MonitorContext } from "@/lib/extensions/monitor/context";
import { guardMonitorProvider } from "@/lib/extensions/monitor/provider";

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
  fileBrowser,
  terminal,
  history,
  forwarding,
  monitor,
  suspended = false,
  validationError = "plugin.frontend.missingWorkspace",
}: {
  target: FrontendProviderTarget;
  children: ReactNode;
  slots?: FrontendWorkbenchSlots;
  validate?: () => boolean;
  subscribe?: (receive: () => void) => () => void;
  visible?: boolean;
  keepFallback?: boolean;
  fileBrowser?: FrontendFileBrowser;
  terminal?: FrontendTerminal;
  history?: HistoryContext & Pick<FrontendHistory, "Entries">;
  forwarding?: ForwardingContext & Pick<FrontendForwarding, "Entries">;
  monitor?: MonitorContext & Pick<FrontendMonitor, "Charts">;
  suspended?: boolean;
  validationError?: string;
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
    !suspended &&
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
      if (!validate()) fail(new Error(validationError));
    };
    check();
    // Observe mount ownership, never terminal/editor DOM mutations at output frequency.
    return subscribe?.(check);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [View, identity, validate, subscribe, validationError]);
  const reset = () => {
    const next = { ...useSettings.getState().settings.uiProviders };
    delete next[target];
    void useSettings.getState().update({ uiProviders: next });
  };
  const active = !!View;
  const [selectionEpoch, setSelectionEpoch] = useState(0);
  const committedLease = useRef<object | null>(null);
  const accessLease = useMemo(
    () => createProviderLease(),
    // A context is owned by this exact provider generation and terminal bridge.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      identity,
      token,
      View,
      active,
      terminal,
      forwarding?.snapshot.hostId,
      monitor?.snapshot.sessionId,
      selectionEpoch,
    ],
  );
  useLayoutEffect(() => {
    accessLease.activate();
    committedLease.current = active ? accessLease : null;
    // Retire synchronously even when A -> B -> A is batched into one React commit.
    const unsubscribe = useSettings.subscribe((state, previous) => {
      const next = state.settings.uiProviders?.[target];
      const before = previous.settings.uiProviders?.[target];
      if (next?.pluginId !== before?.pluginId || next?.viewId !== before?.viewId) {
        accessLease.close();
        setSelectionEpoch((epoch) => epoch + 1);
      }
    });
    return () => {
      unsubscribe();
      committedLease.current = null;
      accessLease.close();
    };
  }, [active, accessLease, target]);
  const checkAccess = (mutation = true) => {
    const current = selectedUiProvider(
      usePlugins.getState().items,
      useSettings.getState().settings.uiProviders,
      target,
    );
    const policy = usePluginSecurity.getState().state;
    if (
      !active ||
      accessLease.isClosed() ||
      (mutation && committedLease.current !== accessLease) ||
      !selected ||
      policy.restricted ||
      current?.plugin.id !== selected.plugin.id ||
      current.view.id !== selected.view.id ||
      current.plugin.fingerprint !== selected.plugin.fingerprint ||
      current.plugin.status !== "running" ||
      frontendRuntime.token(current.plugin.id) !== token ||
      frontendRuntime.view(current.plugin.id, current.view.id, current.plugin.fingerprint) !==
        View ||
      (isTauri() && !hasPluginGrant(policy, current.plugin))
    )
      throw new Error("plugin.frontend.viewUnavailable");
  };
  // Factories capture authorization callbacks; they do not read host refs during render.
  /* eslint-disable react-hooks/refs */
  const files =
    fileBrowser && active ? guardFileBrowserProvider(fileBrowser, checkAccess) : undefined;
  const monitorContext = monitor && active ? guardMonitorProvider(monitor, checkAccess) : undefined;
  const terminalContext =
    terminal && active
      ? guardTerminalProvider(terminal, checkAccess, accessLease, (error) =>
          reportError(`plugins.${selected!.plugin.id}.frontend`, "terminal.subscription", error),
        )
      : undefined;
  /* eslint-enable react-hooks/refs */
  // Delayed confirmations retain a live permission check, never a cached grant.
  /* eslint-disable react-hooks/refs */
  const historyContext =
    history && active
      ? guardHistoryProvider(
          history,
          checkAccess,
          selected!.plugin.permissions,
          () =>
            usePlugins.getState().items.find((item) => item.id === selected!.plugin.id)
              ?.permissions ?? [],
        )
      : undefined;
  /* eslint-enable react-hooks/refs */
  const forwardingContext = useForwardingProvider(
    active ? forwarding : undefined,
    token || undefined,
    selected?.view.id,
    selected?.plugin.id,
    selected?.plugin.permissions.includes("forwards.write") ?? false,
    checkAccess,
    accessLease,
  );
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
              fileBrowser={files}
              terminal={terminalContext}
              history={historyContext}
              forwarding={forwardingContext}
              monitor={monitorContext}
            />
          </ProviderBoundary>
        </div>
      ) : null}
    </>
  );
}
