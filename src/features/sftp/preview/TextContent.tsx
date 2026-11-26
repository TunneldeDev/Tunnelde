import { useTranslation } from "react-i18next";
import { usePanelViewState } from "@/lib/panels/viewState";
import { Button } from "@/components/ui/form/Button";
import { PluginMarkdown } from "@/features/plugins/PluginMarkdown";
import { CodePreview } from "./CodePreview";
import type { PreviewSyntaxSource } from "./usePreviewSyntax";
import type { PreviewFile } from "@/store/filePreview";

export function TextContent({
  file,
  content,
  encoding,
  markdown,
  syntax,
  active = true,
}: {
  file: PreviewFile;
  content: string;
  encoding?: string;
  markdown: boolean;
  syntax?: PreviewSyntaxSource;
  active?: boolean;
}) {
  const { t } = useTranslation();
  const [renderMarkdown, setRenderMarkdown] = usePanelViewState(
    "text.markdown",
    file.line === 0 && markdown,
    (value): value is boolean => typeof value === "boolean",
  );
  return (
    <>
      {markdown || encoding ? (
        <div className="file-preview__toolbar">
          {encoding ? <span className="file-preview__encoding">{encoding}</span> : null}
          {markdown ? (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => setRenderMarkdown((value) => !value)}
            >
              {t(renderMarkdown ? "sftp.previewSource" : "sftp.previewRendered")}
            </Button>
          ) : null}
        </div>
      ) : null}
      {renderMarkdown ? (
        <div className="file-preview__markdown" data-panel-scroll="preview.markdown">
          <PluginMarkdown source={content} />
        </div>
      ) : (
        <CodePreview file={file} content={content} syntax={syntax} active={active} />
      )}
    </>
  );
}
