import { useEffect, useLayoutEffect, useState } from "react";
import { create } from "zustand";
import { EditorPage, EditorPageView } from "./EditorPage";
import { createEditorWindowBinding, useMainEditorWindowServices } from "./editorWindowBinding";
import { useEditorWindowRegistrations } from "./editorWindowRegistration";
import type { EditorWindowModel } from "./editorWindowModel";
import { useNativeReadModel, type NativeViewProps } from "@/lib/panels/useNativeReadModel";
import { useWindowViews } from "@/lib/panels/windowViews";
import type { WindowViewRecord } from "@/lib/panels/windowViews";
import { NativePanelView } from "@/components/layout/NativePanelView";
import { NativeWorkspaceFrame } from "@/components/layout/NativeWorkspaceFrame";
import { useLocalPanelScope } from "@/lib/panels/localWorkspaceScope";
import { isTauri } from "@/lib/api/ipc";
export const useNativeEditorTitles = create<{ titles: Record<string, string> }>(() => ({
  titles: {},
}));
function MainRenderer({
  tabId,
  active,
  record,
}: {
  tabId: string;
  active: boolean;
  record: WindowViewRecord;
}) {
  const services = useMainEditorWindowServices(record, tabId);
  return <EditorPageView tabId={tabId} active={active && !record.staged} services={services} />;
}
export function MainNativeEditorPage({ tabId, active }: { tabId: string; active: boolean }) {
  const id = useEditorWindowRegistrations((s) => s.entries.get(tabId));
  const record = useWindowViews((s) => s.entries.get(id ?? ""));
  if (!isTauri()) return <EditorPage tabId={tabId} active={active} />;
  if (!id) return <div role="status" aria-busy="true" />;
  return (
    <NativePanelView panelId={id}>
      {record ? (
        <MainRenderer key={record.key} tabId={tabId} active={active} record={record} />
      ) : (
        <div role="status" aria-busy="true" />
      )}
    </NativePanelView>
  );
}
function Renderer({
  client,
  record,
  model,
  active,
}: NativeViewProps & { model: EditorWindowModel; active: boolean }) {
  const [binding] = useState(() => createEditorWindowBinding(client, record, model));
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
    <EditorPageView
      tabId={model.tabId}
      active={active && !record.staged}
      services={binding.services}
    />
  );
}
export function NativeEditorView(props: NativeViewProps) {
  const model = useNativeReadModel<EditorWindowModel>(props),
    scope = useLocalPanelScope();
  useEffect(() => {
    if (model?.editor.entry)
      useNativeEditorTitles.setState((s) =>
        s.titles[props.record.panelId] === model.editor.entry!.name
          ? s
          : { titles: { ...s.titles, [props.record.panelId]: model.editor.entry!.name } },
      );
  }, [model, props.record.panelId]);
  if (!model) return <div role="status" aria-busy="true" />;
  const content = <Renderer {...props} model={model} active={scope?.visible ?? true} />;
  return (
    <NativePanelView panelId={props.record.panelId}>
      {scope ? (
        <NativeWorkspaceFrame scope={scope} title={model.editor.entry?.name ?? "Editor"}>
          {content}
        </NativeWorkspaceFrame>
      ) : (
        content
      )}
    </NativePanelView>
  );
}
