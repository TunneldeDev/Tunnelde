import {
  useEffect,
  useMemo,
  useSyncExternalStore,
  type ComponentType,
  type ReactNode,
} from "react";
import { frontendRuntime } from "../../frontendRuntime";
import type { FrontendViewProps } from "../../contracts/frontend/views";
import type { ResourceScope } from "../scopes/contracts";
import { createViewMount } from "./mount";
import { LegacyPanelView } from "./LegacyPanelView";

export interface ViewValidation {
  check(): boolean;
  subscribe?: (receive: () => void) => () => void;
  error: string;
}

function MountedView({
  View,
  resources,
  viewProps,
  validation,
  onFailure,
  onMounted,
  captureLegacyState,
}: {
  View: ComponentType<FrontendViewProps>;
  resources: ResourceScope;
  viewProps: FrontendViewProps;
  validation?: ViewValidation;
  onFailure: (error: unknown) => void;
  onMounted?: () => void;
  captureLegacyState?: boolean;
}) {
  useEffect(() => {
    const check = () => {
      if (resources.signal.aborted) return;
      try {
        if (validation && !validation.check()) throw new Error(validation.error);
        onMounted?.();
      } catch (error) {
        resources.dispose();
        onFailure(error);
      }
    };
    // The registered component and its native slots have actually committed now.
    check();
    return validation?.subscribe?.(check);
  }, [resources, validation, onFailure, onMounted]);
  return captureLegacyState ? (
    <LegacyPanelView View={View} viewProps={viewProps} resources={resources} />
  ) : (
    <View {...viewProps} resources={resources} />
  );
}

/** Shared ordinary/provider mount lifecycle. Never changes native resource ownership. */
export function PluginRuntimeView({
  View,
  viewProps,
  token,
  fingerprint,
  owner,
  beforeOpen,
  retain,
  validation,
  onFailure,
  fallback,
  onMounted,
  captureLegacyState,
}: {
  View: ComponentType<FrontendViewProps>;
  viewProps: FrontendViewProps;
  token: string | undefined;
  fingerprint?: string;
  owner?: object;
  beforeOpen?: () => void;
  retain?: (release: () => void) => () => void;
  validation?: ViewValidation;
  onFailure: (error: unknown) => void;
  fallback?: ReactNode;
  onMounted?: () => void;
  captureLegacyState?: boolean;
}) {
  const { pluginId, viewId } = viewProps;
  const mount = useMemo(
    () =>
      createViewMount(
        () => {
          beforeOpen?.();
          return frontendRuntime.viewScope(pluginId, viewId, token, View, fingerprint);
        },
        (error) => {
          // A retired effect must not latch an error onto its replacement renderer.
          if (
            frontendRuntime.token(pluginId) !== token ||
            frontendRuntime.view(pluginId, viewId, fingerprint) !== View
          )
            return;
          try {
            beforeOpen?.();
          } catch {
            return;
          }
          onFailure(error);
        },
        retain,
      ),
    // Guards and failure callbacks belong to this exact owner/renderer generation.
    // Visible snapshots and callback wrapper identities must not remount the view.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pluginId, viewId, token, fingerprint, View, owner],
  );
  const resources = useSyncExternalStore(mount.subscribe, mount.snapshot, mount.snapshot);
  useEffect(() => mount.activate(), [mount]);
  return resources ? (
    <MountedView
      View={View}
      resources={resources}
      viewProps={viewProps}
      validation={validation}
      onFailure={onFailure}
      onMounted={onMounted}
      captureLegacyState={captureLegacyState}
    />
  ) : (
    fallback
  );
}
