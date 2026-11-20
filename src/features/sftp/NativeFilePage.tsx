import { useEffect, useLayoutEffect, useState } from "react";
import { create } from "zustand";
import { useTranslation } from "react-i18next";
import { SftpPage, type SftpPageProps } from "./SftpPage";
import { SftpPageView } from "./SftpPageView";
import { createFileWindowBinding } from "./fileWindowBinding";
import type { FileWindowModel } from "./fileWindowModel";
import { useNativeReadModel, type NativeViewProps } from "@/lib/panels/useNativeReadModel";
import { useWindowViews, windowViews } from "@/lib/panels/windowViews";
import { usePanelWindows } from "@/store/panelWindows";
import { useLocalPanelScope } from "@/lib/panels/localWorkspaceScope";
import { NativePanelView } from "@/components/layout/NativePanelView";
import { NativeWorkspaceFrame } from "@/components/layout/NativeWorkspaceFrame";
import { movePanelToWindow } from "@/lib/panels/windowMoves";
import { isTauri } from "@/lib/api/ipc";
import { toast } from "@/store/toasts";
import { translateError } from "@/lib/api/errors";
export const useNativeFileTitles = create<{ titles: Record<string, string> }>(() => ({
  titles: {},
}));
const presented = () => {};
export function MainNativeFilePage(props: SftpPageProps) {
  const available = usePanelWindows((s) => s.available),
    record = useWindowViews((s) => s.entries.get(props.tabId ?? "")),
    client = windowViews()?.client;
  if (!isTauri()) return <SftpPage {...props} />;
  if (!available || !client) return <div role="status" aria-busy="true" />;
  if (!record)
    return (
      <NativePanelView panelId={props.tabId ?? ""}>
        <div role="status" aria-busy="true" />
      </NativePanelView>
    );
  return <NativeFileView client={client} record={record} presented={presented} />;
}
function Renderer({ client, record, model }: NativeViewProps & { model: FileWindowModel }) {
  const [binding] = useState(() => createFileWindowBinding(client, record, model));
  useLayoutEffect(() => {
    const unregister = binding.mount();
    return () => {
      unregister();
      binding.dispose();
    };
  }, [binding]);
  useLayoutEffect(() => {
    binding.update(model);
    binding.activate();
  }, [binding, model, record]);
  return (
    <SftpPageView
      key={model.files.props.single ? "single" : "dual"}
      {...model.files.props}
      services={binding.services}
    />
  );
}
export function NativeFileView(props: NativeViewProps) {
  const model = useNativeReadModel<FileWindowModel>(props),
    scope = useLocalPanelScope(),
    { t } = useTranslation();
  useEffect(() => {
    if (model)
      useNativeFileTitles.setState((s) =>
        s.titles[props.record.panelId] === model.files.tab.title
          ? s
          : { titles: { ...s.titles, [props.record.panelId]: model.files.tab.title } },
      );
  }, [model, props.record.panelId]);
  if (!model) return <div role="status" aria-busy="true" />;
  const content = (
    <>
      {props.client.windowId !== "main" && model.files.providersSelected ? (
        <div className="native-panel-interruption" role="status">
          {t("plugin.frontend.viewUnavailable")}
          <button
            type="button"
            onClick={() =>
              void movePanelToWindow(props.record.panelId, "main").catch((e) =>
                toast(translateError(e), "error"),
              )
            }
          >
            {t("panels.returnToMainWindow")}
          </button>
        </div>
      ) : null}
      <Renderer {...props} model={model} />
    </>
  );
  return (
    <NativePanelView panelId={props.record.panelId}>
      {scope ? (
        <NativeWorkspaceFrame scope={scope} title={model.files.tab.title}>
          {content}
        </NativeWorkspaceFrame>
      ) : (
        content
      )}
    </NativePanelView>
  );
}
