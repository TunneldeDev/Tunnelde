import { useEffect, useRef } from "react";
import { usePreviewMediaState } from "./preview/mediaState";
import { useTranslation } from "react-i18next";

export function MediaPreview({
  kind,
  url,
  name,
  onError,
  onReady,
}: {
  kind: "image" | "audio" | "video";
  url: string;
  name: string;
  onError: () => void;
  onReady?: () => void;
}) {
  const { t } = useTranslation();
  const mediaRef = useRef<HTMLMediaElement | null>(null);
  const restore = usePreviewMediaState(mediaRef);
  useEffect(() => {
    const element = mediaRef.current;
    if (!element) return;
    // Cleanup also runs during StrictMode's mount replay and before URL
    // changes. Restore the source in setup so a surviving player can reload.
    if (element.getAttribute("src") !== url) element.setAttribute("src", url);
    return () => {
      element.pause();
      element.removeAttribute("src");
      element.load();
    };
  }, [kind, url, mediaRef]);
  return (
    <div className={`file-preview__media file-preview__media--${kind}`}>
      {kind === "image" ? (
        <img src={url} alt={name} onError={onError} onLoad={onReady} draggable={false} />
      ) : kind === "video" ? (
        <video
          ref={(element) => {
            mediaRef.current = element;
          }}
          src={url}
          controls
          preload="metadata"
          onError={onError}
          onLoadedMetadata={() => {
            restore();
            onReady?.();
          }}
          aria-label={name}
        />
      ) : (
        <div className="file-preview__audio">
          <p>{name}</p>
          <audio
            ref={(element) => {
              mediaRef.current = element;
            }}
            src={url}
            controls
            preload="metadata"
            onError={onError}
            onLoadedMetadata={() => {
              restore();
              onReady?.();
            }}
            aria-label={name}
          />
        </div>
      )}
      {kind !== "image" ? <p className="settings-hint">{t("preview.codecHint")}</p> : null}
    </div>
  );
}
