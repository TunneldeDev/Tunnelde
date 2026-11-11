import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { Button } from "@/components/ui/form/Button";
import { Dialog } from "@/components/ui/overlay/Dialog";
import { api, isTauri } from "@/lib/api/ipc";
import { translateError } from "@/lib/api/errors";
import { supportsManifestVersion } from "@/lib/plugins/activation/compatibility";
import { usePlugins } from "@/store/plugins";
import { toast } from "@/store/toasts";

export function LocalPluginInstall({ request }: { request: number }) {
  const { t } = useTranslation();
  const [path, setPath] = useState<string | null>(null),
    [open, setOpen] = useState(false);
  const [revision, setRevision] = useState(0);
  const [preview, setPreview] = useState<Awaited<ReturnType<typeof api.pluginInspect>> | null>(
      null,
    ),
    [error, setError] = useState<string | null>(null),
    [busy, setBusy] = useState(false);
  const lock = useRef(false),
    anchor = useRef<HTMLSpanElement>(null);
  const [previousRequest, setPreviousRequest] = useState(request);
  if (request !== previousRequest) {
    setPreviousRequest(request);
    setPath(null);
    setPreview(null);
    setError(null);
    setOpen(true);
  }
  const choose = useCallback((next: string) => {
    setPath(next);
    setPreview(null);
    setError(null);
    setRevision((value) => value + 1);
  }, []);
  useEffect(() => {
    let alive = true;
    if (path)
      void api
        .pluginInspect(path)
        .then((p) => {
          if (alive) setPreview(p);
        })
        .catch((e) => {
          if (alive) setError(translateError(e));
        });
    return () => {
      alive = false;
    };
  }, [path, revision]);
  useEffect(() => {
    if (!isTauri()) return;
    let alive = true;
    let unlisten: (() => void) | undefined;
    void getCurrentWebview()
      .onDragDropEvent((e) => {
        if (
          e.payload.type !== "drop" ||
          lock.current ||
          anchor.current?.parentElement?.closest("[hidden]")
        )
          return;
        const hit = document.elementFromPoint(
          e.payload.position.x / window.devicePixelRatio,
          e.payload.position.y / window.devicePixelRatio,
        );
        if (!hit?.closest(".plugins-sidebar,.plugins-browser,.plugin-install-dialog")) return;
        const first = e.payload.paths[0];
        if (first) {
          choose(first);
          setOpen(true);
        }
      })
      .then((fn) => {
        if (alive) unlisten = fn;
        else fn();
      })
      .catch(() => undefined);
    return () => {
      alive = false;
      unlisten?.();
    };
  }, [choose]);
  const pick = async (archive: boolean) => {
    try {
      const selected = await (archive ? api.pluginPickArchive() : api.pluginPickFolder());
      if (selected) choose(selected);
    } catch (e) {
      toast(translateError(e), "error");
    }
  };
  const install = async () => {
    if (!path || !preview || lock.current) return;
    lock.current = true;
    setBusy(true);
    try {
      if (await usePlugins.getState().install(path)) {
        setOpen(false);
        toast(t("plugins.installed"), "success");
      }
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  return (
    <>
      <span ref={anchor} hidden />
      <Dialog
        open={open}
        title={t("plugins.installTitle")}
        className="plugin-install-dialog"
        width={560}
        closeLabel={t("common.close")}
        onClose={() => setOpen(false)}
        dismissible={!busy}
        footer={
          <>
            <Button disabled={busy} onClick={() => setOpen(false)}>
              {t("common.cancel")}
            </Button>
            <Button
              variant="primary"
              disabled={!preview || !supportsManifestVersion(preview.apiVersion) || busy}
              onClick={() => void install()}
            >
              {t(busy ? "plugins.installing" : "plugins.install")}
            </Button>
          </>
        }
      >
        <div className="plugin-install-choices">
          <Button disabled={busy} onClick={() => void pick(true)}>
            {t("plugins.browseArchive")}
          </Button>
          <Button disabled={busy} onClick={() => void pick(false)}>
            {t("plugins.browseFolder")}
          </Button>
        </div>
        <p className="settings-hint">{t("plugins.dropHint")}</p>
        {path ? <p className="plugin-install-path">{path}</p> : null}
        {preview ? (
          <div className="plugin-install-preview">
            <strong>{preview.name}</strong>
            <span>{preview.version}</span>
            <p className="settings-hint">
              {t(preview.runtime === "theme" ? "market.themeInstallBody" : "market.installBody", {
                name: preview.name,
                version: preview.version,
                source: path,
                runtime: preview.runtime ?? "node",
              })}
            </p>
            {preview.themes?.length ? (
              <div className="plugin-install-themes">
                <span>{t("plugins.themes")}</span>
                <ul>
                  {preview.themes.map((theme) => (
                    <li key={theme.id}>{theme.name}</li>
                  ))}
                </ul>
              </div>
            ) : null}
            {!supportsManifestVersion(preview.apiVersion) ? (
              <p role="alert" className="panel__error">
                {t("market.incompatibleApi")}
              </p>
            ) : null}
          </div>
        ) : path && !error ? (
          <p role="status">{t("common.loading")}</p>
        ) : null}
        {error ? (
          <p className="panel__error" role="alert">
            {error}
          </p>
        ) : null}
      </Dialog>
    </>
  );
}
