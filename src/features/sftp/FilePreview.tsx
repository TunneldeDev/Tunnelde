import { previewKeyDown } from "./preview/previewKeyboard";
import { convertFileSrc } from "@tauri-apps/api/core";
import { useWindowViews, windowViews, renderablePanel } from "@/lib/panels/windowViews";
import { usePanelWindows } from "@/store/panelWindows";
import { usePreviewReadSource } from "./preview/usePreviewReadSource";
import { previewWindowData } from "./preview/windowModel";
import { NativePreviewContent } from "./preview/NativePreviewContent";
import { useCallback, useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { SidebarPortal } from "@/components/layout/SidebarDock";
import { SidebarDockControls, SidebarTitle } from "@/components/layout/SidebarDockControls";
import { Button } from "@/components/ui/form/Button";
import { FileTypeIcon } from "@/components/ui/display/FileTypeIcon";
import { useFileIconResolver } from "@/lib/files/icons";
import { Select } from "@/components/ui/form/Select";
import { matchesPreview, previewProviders } from "@/lib/files/preview";
import { usePlugins } from "@/store/plugins";
import { useMarketplace } from "@/store/marketplace";
import { useNavigation } from "@/store/navigation";
import { TextPreview } from "./TextPreview";
import { ProviderPreview } from "./ProviderPreview";
import {
  previewPanelOpen,
  useFilePreview,
  type PreviewFile,
  type PreviewPresentation,
} from "@/store/filePreview";
import { fileName } from "@/store/editors";
import { useSsh } from "@/store/ssh";
import { useWorkspace } from "@/store/workspace";
import { usePreviewSession } from "./preview/usePreviewSession";
import { PreviewSurface } from "./preview/PreviewSurface";
import { PreviewFrame } from "./preview/PreviewFrame";
import { PreviewBody } from "./preview/PreviewBody";
import { usePreviewOwner } from "./preview/usePreviewOwner";
import { usePreviewReadOwner } from "./preview/usePreviewReadSource";

export function FilePreview() {
  const file = useFilePreview((state) => state.file);
  const id = useFilePreview((state) => state.id);
  const presentation = useFilePreview((state) => state.presentation);
  const panel = useWorkspace((state) => state.tabs.find((tab) => tab.id === "sidebar:filePreview"));
  const sidebarVisible = useNavigation((state) => state.sidebarVisible);
  const activeSidebar = useNavigation((state) => state.activeSidebar);
  const nativeAvailable = usePanelWindows((state) => state.available);
  const nativeTarget = usePanelWindows(
    (state) =>
      state.snapshot.panels.some(
        (panel) => panel.panelId === "filePreview" && panel.windowId !== "main",
      ) || state.snapshot.transfers.some(({ offer }) => offer.lease.panelId === "filePreview"),
  );
  const preserveNative = nativeAvailable && renderablePanel("filePreview") && nativeTarget;
  const panelOpen = panel ? !panel.hidden : sidebarVisible && activeSidebar === "filePreview";
  useEffect(() => {
    const current = useFilePreview.getState();
    if (
      file &&
      !preserveNative &&
      current.file === file &&
      current.id === id &&
      current.presentation === "docked" &&
      !previewPanelOpen()
    )
      current.close();
  }, [file, id, presentation, panel, sidebarVisible, activeSidebar, preserveNative]);
  return file && (presentation === "quickLook" || panelOpen || preserveNative) ? (
    <Preview id={id!} file={file} presentation={presentation} />
  ) : (
    <SidebarPortal view="filePreview">
      <PreviewPlaceholder />
    </SidebarPortal>
  );
}
function PreviewPlaceholder() {
  const { t } = useTranslation();
  return (
    <section className="sidebar file-preview-panel">
      <header className="sidebar__head">
        <SidebarTitle view="filePreview">{t("sftp.preview")}</SidebarTitle>
        <SidebarDockControls view="filePreview" />
      </header>
      <div className="file-preview-panel__placeholder">{t("preview.panelHint")}</div>
    </section>
  );
}
function Preview({
  file,
  id,
  presentation,
}: {
  file: PreviewFile;
  id: string;
  presentation: PreviewPresentation;
}) {
  const { t } = useTranslation();
  const resolveFileIcon = useFileIconResolver();
  const focusPreview = useCallback(
    (node: HTMLDivElement | null) => {
      if (node && presentation === "quickLook") node.focus({ preventScroll: true });
    },
    [presentation],
  );
  const plugins = usePlugins((state) => state.items);
  const providers = useMemo(
    () => previewProviders(plugins).filter((provider) => matchesPreview(provider, file.path)),
    [plugins, file.path],
  );
  const {
    context,
    provider,
    renderer: kind,
    attemptId,
    onReady,
    onReadError,
    onDecodeError,
  } = usePreviewSession(file, id, providers, presentation);
  const readSource = usePreviewReadOwner(file, kind, attemptId, provider);
  usePreviewOwner({ context, source: readSource, providers, onReady, onDecodeError });
  const text = kind === "text" || kind === "markdown";
  const session = useSsh((state) =>
    state.sessions.find(
      (session) => file.source.kind === "remote" && session.id === file.source.sessionId,
    ),
  );
  const nativeAvailable = usePanelWindows((state) => state.available);
  const record = useWindowViews((state) => state.entries.get("filePreview"));
  const read = usePreviewReadSource(readSource);
  useEffect(() => {
    if (read.status === "error") {
      if (read.stage === "read") onReadError();
      else onDecodeError();
    }
  }, [read, onReadError, onDecodeError]);
  // The coordinator/read owner above survives an absent NativePanelView body.
  // The actual renderer is an ordinary descendant of its capture/lease scopes.
  if (presentation === "docked" && nativeAvailable && renderablePanel("filePreview")) {
    const client = windowViews()?.client;
    const data = previewWindowData({ context, source: readSource, providers });
    const mainUrl =
      read.status === "ready" && read.value.info
        ? convertFileSrc(read.value.info.id, "preview")
        : undefined;
    return (
      <SidebarPortal view="filePreview">
        {record && client ? (
          <NativePreviewContent
            key={record.key}
            client={client}
            record={record}
            data={data}
            mainUrl={mainUrl}
          />
        ) : null}
      </SidebarPortal>
    );
  }
  return (
    <PreviewFrame
      title={`${t("sftp.preview")} · ${fileName(file.path)}`}
      onClose={useFilePreview.getState().close}
      onDock={context.dock}
      onUndock={context.undock}
      presentation={presentation}
      actions={
        <>
          {text ? (
            <Button
              variant="secondary"
              disabled={file.source.kind === "remote" && !session}
              onClick={() => {
                if (file.source.kind === "local") {
                  useWorkspace.getState().openLocalEditor(file.path);
                } else if (session) {
                  useWorkspace.getState().openEditor(session, file.path);
                } else {
                  return;
                }
                useFilePreview.getState().close();
              }}
            >
              {t("sftp.edit")}
            </Button>
          ) : null}
        </>
      }
    >
      <div
        className="file-preview__content"
        tabIndex={-1}
        ref={focusPreview}
        onKeyDownCapture={(event) =>
          previewKeyDown(event, useFilePreview.getState().navigate, context.close)
        }
      >
        <div className="file-preview__target">
          <FileTypeIcon icon={resolveFileIcon(file.path)} />
          <div>
            <strong>{fileName(file.path)}</strong>
            <p className="settings-hint" title={file.path}>
              {file.path}
            </p>
          </div>
        </div>
        {providers.length > 1 ? (
          <Select
            value={provider!.id}
            options={providers.map((item) => ({
              value: item.id,
              label: `${item.name} · ${item.pluginName}`,
            }))}
            onChange={context.selectProvider}
            label={t("preview.provider")}
          />
        ) : null}
        <PreviewSurface context={context}>
          <PreviewBody attemptId={attemptId}>
            {provider ? (
              <ProviderPreview
                key={attemptId}
                file={file}
                provider={provider}
                source={readSource}
                onReady={onReady}
                onReadError={onReadError}
                onDecodeError={onDecodeError}
                onRetry={context.retry}
              />
            ) : text ? (
              <TextPreview
                key={attemptId}
                file={file}
                source={readSource}
                onReady={onReady}
                onError={onReadError}
              />
            ) : (
              <div className="file-preview__empty">
                <p>{t("preview.installHint")}</p>
                <Button
                  variant="primary"
                  onClick={() => {
                    useMarketplace.getState().setScope("market");
                    useMarketplace.getState().setTag("");
                    useMarketplace.getState().setQuery("@tag:preview");
                    useNavigation.getState().showSidebar("plugins");
                    useFilePreview.getState().close();
                  }}
                >
                  {t("preview.findPlugins")}
                </Button>
              </div>
            )}
          </PreviewBody>
        </PreviewSurface>
      </div>
    </PreviewFrame>
  );
}
