import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Dialog } from "@/components/ui/overlay/Dialog";
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
import { useFilePreview, type PreviewFile } from "@/store/filePreview";
import { fileName } from "@/store/editors";
import { useSsh } from "@/store/ssh";
import { useWorkspace } from "@/store/workspace";
import { usePreviewSession } from "./preview/usePreviewSession";
import { PreviewSurface } from "./preview/PreviewSurface";

export function FilePreview() {
  const file = useFilePreview((state) => state.file);
  const id = useFilePreview((state) => state.id);
  return file ? <Preview key={id} id={id!} file={file} /> : null;
}
function Preview({ file, id }: { file: PreviewFile; id: string }) {
  const { t } = useTranslation();
  const resolveFileIcon = useFileIconResolver();
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
  } = usePreviewSession(file, id, providers);
  const text = kind === "text" || kind === "markdown";
  const session = useSsh((state) =>
    state.sessions.find(
      (session) => file.source.kind === "remote" && session.id === file.source.sessionId,
    ),
  );
  return (
    <Dialog
      open
      title={`${t("sftp.preview")} · ${fileName(file.path)}`}
      closeLabel={t("common.close")}
      onClose={useFilePreview.getState().close}
      width={820}
      className="file-preview"
      footer={
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
      <p
        className="settings-hint"
        style={{ overflowWrap: "anywhere", display: "flex", gap: 8, alignItems: "center" }}
      >
        <FileTypeIcon icon={resolveFileIcon(file.path)} />
        <span>{file.path}</span>
      </p>
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
        {provider ? (
          <ProviderPreview
            key={attemptId}
            file={file}
            provider={provider}
            onReady={onReady}
            onReadError={onReadError}
            onDecodeError={onDecodeError}
            onRetry={context.retry}
          />
        ) : text ? (
          <TextPreview key={attemptId} file={file} onReady={onReady} onError={onReadError} />
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
      </PreviewSurface>
    </Dialog>
  );
}
