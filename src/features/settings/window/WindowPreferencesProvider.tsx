import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ComponentProps,
} from "react";
import type { PreferenceSurfaceServices } from "../components/PreferenceSurfaceView";
import {
  createWindowProviderSource,
  type WindowProviderOwner,
} from "@/lib/panels/windowProviderSource";
import { createWindowProviderOwner } from "@/lib/panels/windowProviderOwner";
import { useWindowViews, windowViews, type WindowViewRecord } from "@/lib/panels/windowViews";
import type { PanelWindowClient } from "@/lib/panels/windowClient";
import { usePanelWindows } from "@/store/panelWindows";
import { openScopedFrontendView } from "@/lib/extensions/runtime/views/frontend";
import { createResourceScope } from "@/lib/extensions/resourceScope";
import { guardPreferencesProvider } from "@/lib/extensions/preferences/provider";
import type { FrontendViewProps } from "@/lib/extensions/uiSdk";
import { usePanelReadiness } from "@/lib/panels/usePanelReadiness";
import { useFactorySelection } from "@/lib/extensions/runtime/views/useFactorySelection";
import { reportError } from "@/lib/diagnostics";
import { translateError } from "@/lib/api/errors";
import { Button } from "@/components/ui/form/Button";
import { useTranslation } from "react-i18next";

type Frame = ComponentProps<PreferenceSurfaceServices["Provider"]>;
const Owner = createContext<WindowProviderOwner | null>(null);
const Context = createContext<Frame | null>(null);
export function SettingsProviderScope({
  client,
  record,
  children,
}: {
  client: PanelWindowClient;
  record: WindowViewRecord;
  children: React.ReactNode;
}) {
  const [binding] = useState(() => {
    const views = windowViews();
    return createWindowProviderOwner(client, record, {
      current: () =>
        windowViews() === views ? useWindowViews.getState().entries.get(record.panelId) : undefined,
      frozen: () => {
        const state = usePanelWindows.getState();
        return (
          !state.available ||
          state.windowId !== client.windowId ||
          state.snapshot.transfers.some(({ offer }) => offer.lease.panelId === record.panelId) ||
          !!state.snapshot.interruptions?.some((i) => i.panelId === record.panelId)
        );
      },
    });
  });
  const lease = record.staged ? undefined : record.lease;
  useLayoutEffect(() => binding.start(lease), [binding, lease]);
  return <Owner.Provider value={binding.owner}>{children}</Owner.Provider>;
}
export function createWindowPreferencesProviderSource(
  owner: WindowProviderOwner,
  report: (error: unknown) => void,
) {
  return createWindowProviderSource(owner, report, {
    describe: (client, target) => client.describePreferencesProvider(target),
    async open(client, descriptor, signal, state, check, lifetime) {
      const parent = createResourceScope({ parent: lifetime, report });
      let token = "";
      try {
        const mounted = await openScopedFrontendView({
          owner: descriptor.view,
          viewId: descriptor.view.viewId,
          parent,
          transport: client.transport,
          openView: async () => {
            const session = await client.openPreferencesProvider(owner.target(), descriptor);
            token = session.token;
            return session;
          },
          check,
          state,
          signal,
        });
        const View = mounted.component;
        function PreferencesProvider(props: FrontendViewProps) {
          const frame = useContext(Context);
          if (!frame) throw new Error("plugin.preferences.changed");
          const access = (mutation = true) => {
            if (mounted.resources.signal.aborted) throw new Error("plugin.frontend.expired");
            check();
            owner.check(mutation);
          };
          return (
            <View
              {...props}
              resources={mounted.resources}
              preferences={guardPreferencesProvider(
                frame.context,
                access,
                () => descriptor.capabilities.write,
                (method, params) =>
                  client.transport.call(token, method, params ?? {}, mounted.resources.signal),
              )}
            />
          );
        }
        return { ...mounted, component: PreferencesProvider, dispose: () => parent.dispose() };
      } catch (error) {
        parent.dispose();
        throw error;
      }
    },
  });
}
export function WindowPreferencesProvider(props: Frame) {
  const owner = useContext(Owner),
    { t } = useTranslation();
  if (!owner) throw new Error("panel.window.staleOwner");
  const source = useMemo(
    () =>
      createWindowPreferencesProviderSource(owner, (error) =>
        reportError("panels.settings", "provider", error),
      ),
    [owner],
  );
  const snapshot = useSyncExternalStore(source.subscribe, source.snapshot);
  const selectionError = useFactorySelection(
    true,
    snapshot.source?.descriptor.view ?? null,
    snapshot.loading,
  );
  const error = snapshot.error ?? selectionError;
  usePanelReadiness(
    "preferences.selection",
    !snapshot.loading && error == null,
    error ?? undefined,
  );
  useEffect(() => source.start(), [source]);
  const current = snapshot.source;
  return (
    <Context.Provider value={props}>
      {error ? (
        <div role="alert">
          <p>{translateError(error)}</p>
          <Button onClick={source.revalidate}>{t("common.retry")}</Button>
        </div>
      ) : null}
      {current ? (
        <current.View
          pluginId={current.descriptor.view.pluginId}
          viewId={current.descriptor.view.viewId}
          visible={props.visible}
        />
      ) : snapshot.loading ? (
        <div role="status" aria-busy="true" />
      ) : error ? null : (
        props.children
      )}
    </Context.Provider>
  );
}
