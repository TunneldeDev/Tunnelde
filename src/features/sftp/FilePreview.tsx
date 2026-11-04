import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Dialog } from "@/components/ui/overlay/Dialog";
import { Button } from "@/components/ui/form/Button";
import { FileTypeIcon } from "@/components/ui/display/FileTypeIcon";
import { useFileIconResolver } from "@/lib/files/icons";
import { Select } from "@/components/ui/form/Select";
import { matchesPreview, previewKind, previewProviders } from "@/lib/files/preview";
import { usePlugins } from "@/store/plugins";
import { useMarketplace } from "@/store/marketplace";
import { useNavigation } from "@/store/navigation";
import { TextPreview } from "./TextPreview";
import { ProviderPreview } from "./ProviderPreview";
import { api } from "@/lib/api/ipc";
import { translateError } from "@/lib/api/errors";
import { useFilePreview, type PreviewFile } from "@/store/filePreview";
import { fileName } from "@/store/editors";
import { useSsh } from "@/store/ssh";
import { useWorkspace } from "@/store/workspace";
import { toast } from "@/store/toasts";

export function FilePreview() {
  const file = useFilePreview((state) => state.file);
  return file ? (
    <Preview
      key={`${file.source.kind === "remote" ? file.source.sessionId : "local"}:${file.path}`}
      file={file}
    />
  ) : null;
}
function Preview({ file }: { file: PreviewFile }) {
  const { t } = useTranslation();
  const resolveFileIcon = useFileIconResolver();
  const plugins = usePlugins((state) => state.items);
  const providers = useMemo(
    () => previewProviders(plugins).filter((provider) => matchesPreview(provider, file.path)),
    [plugins, file.path],
  );
  const [preferred, setPreferred] = useState("");
  const provider = providers.find((candidate) => candidate.id === preferred) ?? providers[0];
  const kind = provider?.renderer ?? previewKind(file.path);
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
          {file.source.kind === "local" || text ? (
            <Button
              variant="secondary"
              disabled={file.source.kind === "remote" && !session}
              onClick={() => {
                if (file.source.kind === "local") {
                  void api
                    .openLocalPath(file.path)
                    .catch((cause) => toast(translateError(cause), "error"));
                } else if (session) {
                  useWorkspace.getState().openEditor(session, file.path);
                  useFilePreview.getState().close();
                }
              }}
            >
              {t(file.source.kind === "local" ? "sftp.openWith" : "sftp.edit")}
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
          onChange={setPreferred}
          label={t("preview.provider")}
        />
      ) : null}
      {provider ? (
        <ProviderPreview key={provider.id} file={file} provider={provider} />
      ) : text ? (
        <TextPreview file={file} />
      ) : (
        <div className="file-preview__empty">
          <p>{t("preview.installHint")}</p>
          <Button
            variant="primary"
            onClick={() => {
              useMarketplace.getState().setScope("market");
              useMarketplace.getState().setTag("preview");
              useNavigation.getState().showSidebar("plugins");
              useFilePreview.getState().close();
            }}
          >
            {t("preview.findPlugins")}
          </Button>
        </div>
      )}
    </Dialog>
  );
}
