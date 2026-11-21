import { useCallback, type ComponentProps } from "react";
import { useTranslation } from "react-i18next";
import { SettingsPage } from "../SettingsPage";
import { SettingsWindowOwner, useSettingsOwner } from "./mainBinding";
import { SettingsWindowContent } from "./SettingsWindowContent";
import { SettingsDraftScope } from "./SettingsDraftScope";
import { WindowPreferencesProvider, SettingsProviderScope } from "./WindowPreferencesProvider";
import { useSettingsRegistrations } from "./registration";
import type { SettingsWindowModel } from "./model";
import { ProviderSurface } from "@/components/layout/ProviderSurface";
import { NativePanelView } from "@/components/layout/NativePanelView";
import { NativeWorkspaceFrame } from "@/components/layout/NativeWorkspaceFrame";
import { useNativeReadModel, type NativeViewProps } from "@/lib/panels/useNativeReadModel";
import { useLocalPanelScope } from "@/lib/panels/localWorkspaceScope";
import { useWindowViews } from "@/lib/panels/windowViews";
import { useWorkspace } from "@/store/workspace";
import { mainPanelWindowClient } from "@/app/panelWindows";
import { isTauri } from "@/lib/api/ipc";
import { Button } from "@/components/ui/form/Button";
import { movePanelToWindow } from "@/lib/panels/windowMoves";
import { toast } from "@/store/toasts";
import { translateError } from "@/lib/api/errors";
import { usePanelWindows } from "@/store/panelWindows";

function MainPreferenceProvider({
  context,
  visible,
  children,
}: ComponentProps<typeof WindowPreferencesProvider>) {
  return (
    <ProviderSurface target="preferences" preferences={context} visible={visible}>
      {children}
    </ProviderSurface>
  );
}
/** Exactly one effect/authentication owner per main document, independent of
 * which Settings presentation is currently mounted (or staged). */
export function MainSettingsWindowOwner() {
  const needed = useWorkspace((s) =>
    s.tabs.some((tab) => tab.kind === "settings" || tab.kind === "updates"),
  );
  const show = useCallback(async () => {
    await mainPanelWindowClient()?.show();
  }, []);
  return needed && isTauri() ? <SettingsWindowOwner show={show} /> : null;
}
export function MainNativeSettingsPage({ tabId, visible }: { tabId: string; visible: boolean }) {
  const id = useSettingsRegistrations((s) => s.entries.get(tabId));
  const record = useWindowViews((s) => s.entries.get(id ?? ""));
  const projection = useSettingsOwner((s) => s.projection);
  const client = mainPanelWindowClient();
  const available = usePanelWindows((s) => s.available);
  if (!isTauri() || !available) return <SettingsPage visible={visible} />;
  if (!id) return <div role="status" aria-busy="true" />;
  return (
    <NativePanelView panelId={id}>
      {client && record && projection ? (
        <SettingsDraftScope client={client} record={record}>
          <SettingsWindowContent
            client={client}
            record={record}
            model={projection}
            Provider={MainPreferenceProvider}
            visible={visible}
          />
        </SettingsDraftScope>
      ) : (
        <div role="status" aria-busy="true" />
      )}
    </NativePanelView>
  );
}
function Content(props: NativeViewProps & { model: SettingsWindowModel }) {
  const { t } = useTranslation();
  const allowMove = usePanelWindows(
    (s) =>
      s.snapshot.settingsPages?.find((v) => v.panelId === props.record.panelId)?.allowMove !==
      false,
  );
  // Keep the real provider attachment/draft alive if selection becomes legacy
  // while detached; never substitute builtin Fields without user intent.
  return (
    <SettingsProviderScope client={props.client} record={props.record}>
      <SettingsDraftScope client={props.client} record={props.record}>
        {!allowMove && (
          <div className="native-panel-interruption" role="status">
            {t("plugin.frontend.viewUnavailable")}
            <Button
              onClick={() =>
                void movePanelToWindow(props.record.panelId, "main").catch((e) =>
                  toast(translateError(e), "error"),
                )
              }
            >
              {t("panels.returnToMainWindow")}
            </Button>
          </div>
        )}
        <div className="provider-content" inert={!allowMove}>
          <SettingsWindowContent
            {...props}
            model={props.model.settings}
            Provider={WindowPreferencesProvider}
            visible={!props.record.staged}
          />
        </div>
      </SettingsDraftScope>
    </SettingsProviderScope>
  );
}
export function NativeSettingsView(props: NativeViewProps) {
  const model = useNativeReadModel<SettingsWindowModel>(props),
    scope = useLocalPanelScope(),
    { t } = useTranslation();
  if (!model) return <div role="status" aria-busy="true" />;
  const content = <Content {...props} model={model} />;
  return (
    <NativePanelView panelId={props.record.panelId}>
      {scope ? (
        <NativeWorkspaceFrame scope={scope} title={t("settings.title")}>
          {content}
        </NativeWorkspaceFrame>
      ) : (
        content
      )}
    </NativePanelView>
  );
}
