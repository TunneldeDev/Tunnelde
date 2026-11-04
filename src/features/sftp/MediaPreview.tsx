import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

export function MediaPreview({
  kind,
  url,
  name,
  onError,
}: {
  kind: "image" | "audio" | "video";
  url: string;
  name: string;
  onError: () => void;
}) {
  const { t } = useTranslation();
  const media = useRef<HTMLMediaElement | null>(null);
  useEffect(() => {
    const element = media.current;
    if (!element) return;
    // Cleanup also runs during StrictMode's mount replay and before URL
    // changes. Restore the source in setup so a surviving player can reload.
    if (element.getAttribute("src") !== url) element.setAttribute("src", url);
    return () => {
      element.pause();
      element.removeAttribute("src");
      element.load();
    };
  }, [kind, url]);
  return (
    <div className={`file-preview__media file-preview__media--${kind}`}>
      {kind === "image" ? (
        <img src={url} alt={name} onError={onError} draggable={false} />
      ) : kind === "video" ? (
        <video
          ref={(element) => {
            media.current = element;
          }}
          src={url}
          controls
          preload="metadata"
          onError={onError}
          aria-label={name}
        />
      ) : (
        <div className="file-preview__audio">
          <p>{name}</p>
          <audio
            ref={(element) => {
              media.current = element;
            }}
            src={url}
            controls
            preload="metadata"
            onError={onError}
            aria-label={name}
          />
        </div>
      )}
      {kind !== "image" ? <p className="settings-hint">{t("preview.codecHint")}</p> : null}
    </div>
  );
}
