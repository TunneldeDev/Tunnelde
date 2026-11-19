import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/form/Button";
import { Input } from "@/components/ui/form/Field";
import { Dialog } from "@/components/ui/overlay/Dialog";
import {
  hostImportSelection,
  hostTransferApi,
  useHostTransfer,
  type HostImportPreview,
} from "@/lib/hosts/transfer";
import { translateError } from "@/lib/api/errors";
import { useBackgroundGuard } from "@/lib/session/viewState";
import { useHosts } from "@/store/hosts";
import { useSettings } from "@/store/settings";
import { toast } from "@/store/toasts";
import "@/features/welcome/sshConfigImport.css";

export function HostTransferDialogs() {
  const dialog = useHostTransfer((state) => state.dialog);
  if (!dialog) return null;
  return dialog.kind === "import" ? <ImportHosts /> : <ExportHosts ids={dialog.ids} />;
}
function ExportHosts({ ids }: { ids?: string[] }) {
  const { t } = useTranslation();
  const hosts = useHosts((state) => state.hosts).filter((host) => !host.source);
  const [selected, setSelected] = useState(new Set(ids ?? hosts.map((host) => host.id)));
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const close = useHostTransfer((state) => state.close);
  const visible = hosts.filter((host) =>
    `${host.name} ${host.host} ${host.username}`.toLowerCase().includes(query.toLowerCase()),
  );
  const selectedIds = hosts.filter((host) => selected.has(host.id)).map((host) => host.id);
  useBackgroundGuard(true);
  return (
    <Dialog
      open
      title={t("hostTransfer.exportTitle")}
      closeLabel={t("common.close")}
      onClose={close}
      dismissible={!busy}
      width={560}
      footer={
        <>
          <Button variant="ghost" disabled={busy} onClick={close}>
            {t("common.cancel")}
          </Button>
          <Button
            variant="primary"
            disabled={busy || !selectedIds.length}
            onClick={() => {
              setBusy(true);
              setError(null);
              void hostTransferApi
                .export(selectedIds)
                .then((path) => {
                  if (path) {
                    toast(t("hostTransfer.exported"), "success");
                    close();
                  }
                })
                .catch((cause) => setError(translateError(cause)))
                .finally(() => setBusy(false));
            }}
          >
            {t("hostTransfer.exportSelected", { count: selectedIds.length })}
          </Button>
        </>
      }
    >
      <div className="ssh-import" aria-busy={busy}>
        <p className="td-field__hint">{t("hostTransfer.exportHint")}</p>
        <Input
          aria-label={t("hostTransfer.search")}
          placeholder={t("hostTransfer.search")}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <Button
          size="sm"
          disabled={busy}
          onClick={() =>
            setSelected(
              new Set(
                visible.every((host) => selected.has(host.id))
                  ? [...selected].filter((id) => !visible.some((host) => host.id === id))
                  : [...selected, ...visible.map((host) => host.id)],
              ),
            )
          }
        >
          {t("hostTransfer.toggleAll")}
        </Button>
        <div className="ssh-import__entries">
          {visible.map((host) => (
            <label className="ssh-import__entry" key={host.id}>
              <input
                type="checkbox"
                checked={selected.has(host.id)}
                disabled={busy}
                onChange={(event) => {
                  const checked = event.target.checked;
                  setSelected((current) => {
                    const next = new Set(current);
                    if (checked) next.add(host.id);
                    else next.delete(host.id);
                    return next;
                  });
                }}
              />
              <span className="ssh-import__details">
                <strong>{host.name}</strong>
                <span>
                  {host.username}@{host.host}:{host.port}
                </span>
              </span>
            </label>
          ))}
        </div>
        {error && <p role="alert">{error}</p>}
      </div>
    </Dialog>
  );
}
function ImportHosts() {
  const { t } = useTranslation();
  const [preview, setPreview] = useState<HostImportPreview | null>(null);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [copies, setCopies] = useState(false);
  const [mountPoints, setMountPoints] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const close = useHostTransfer((state) => state.close);
  useBackgroundGuard(true);
  useEffect(() => {
    let active = true;
    void hostTransferApi
      .pick()
      .then((result) => {
        if (!active) return;
        if (!result) {
          close();
          return;
        }
        setPreview(result);
        setChosen(
          new Set(
            result.document.roots.filter(
              (id) =>
                !result.entries.some(
                  (entry) => entry.conflict && hostImportSelection(result, [id]).has(entry.id),
                ),
            ),
          ),
        );
      })
      .catch((cause) => {
        if (active) setError(translateError(cause));
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
    };
  }, [close]);
  const selected = useMemo(
    () => (preview ? hostImportSelection(preview, chosen) : new Set<string>()),
    [preview, chosen],
  );
  const conflict = preview?.entries.some((entry) => selected.has(entry.id) && entry.conflict);
  return (
    <Dialog
      open
      title={t("hostTransfer.importTitle")}
      closeLabel={t("common.close")}
      onClose={close}
      dismissible={!busy}
      width={620}
      footer={
        <>
          <Button variant="ghost" disabled={busy} onClick={close}>
            {t("common.cancel")}
          </Button>
          <Button
            disabled={busy || !preview}
            onClick={() => {
              if (!preview) return;
              setBusy(true);
              setError(null);
              void hostTransferApi
                .preview(preview.document)
                .then(setPreview)
                .catch((cause) => setError(translateError(cause)))
                .finally(() => setBusy(false));
            }}
          >
            {t("sshImport.refresh")}
          </Button>
          <Button
            variant="primary"
            disabled={busy || !selected.size || (!!conflict && !copies)}
            onClick={() => {
              if (!preview) return;
              setBusy(true);
              setError(null);
              void hostTransferApi
                .apply(preview, [...chosen], copies, mountPoints)
                .then(async (hosts) => {
                  for (const host of hosts) useHosts.getState().receiveSavedHost(host);
                  await Promise.all([useHosts.getState().load(), useSettings.getState().load()]);
                  toast(t("sshImport.imported", { count: hosts.length }), "success");
                  close();
                })
                .catch((cause) => setError(translateError(cause)))
                .finally(() => setBusy(false));
            }}
          >
            {t("sshImport.importSelected", { count: selected.size })}
          </Button>
        </>
      }
    >
      <div className="ssh-import" aria-busy={busy}>
        <p className="td-field__hint">{t("hostTransfer.importHint")}</p>
        <p className="td-field__hint">{t("hostTransfer.credentialsHint")}</p>
        {busy && <p role="status">{t("common.loading")}</p>}
        {preview && (
          <>
            <label className="ssh-import__entry">
              <input
                type="checkbox"
                checked={copies}
                disabled={busy}
                onChange={(event) => setCopies(event.target.checked)}
              />
              <span>{t("hostTransfer.copies")}</span>
            </label>
            <Button
              size="sm"
              disabled={busy}
              onClick={() =>
                setChosen((current) =>
                  current.size
                    ? new Set()
                    : new Set(
                        preview.entries
                          .filter(
                            (entry) =>
                              copies ||
                              ![...hostImportSelection(preview, [entry.id])].some((id) =>
                                preview.entries.some((host) => host.id === id && host.conflict),
                              ),
                          )
                          .map((entry) => entry.id),
                      ),
                )
              }
            >
              {t("hostTransfer.toggleAll")}
            </Button>
            <div className="ssh-import__entries">
              {preview.entries.map((entry) => (
                <div key={entry.id}>
                  <label className="ssh-import__entry">
                    <input
                      type="checkbox"
                      checked={selected.has(entry.id)}
                      disabled={busy || (selected.has(entry.id) && !chosen.has(entry.id))}
                      onChange={(event) => {
                        const checked = event.target.checked;
                        setChosen((current) => {
                          const next = new Set(current);
                          if (checked) next.add(entry.id);
                          else next.delete(entry.id);
                          return next;
                        });
                      }}
                    />
                    <span className="ssh-import__details">
                      <strong>{entry.name}</strong>
                      <span>{entry.address}</span>
                      {entry.conflict && <span>{t("hostTransfer.conflictLabel")}</span>}
                      {entry.dependency && <span>{t("hostTransfer.dependency")}</span>}
                      <span>
                        {t("hostTransfer.ruleCounts", {
                          forwards: entry.forwards,
                          mounts: entry.mounts,
                        })}
                      </span>
                      {!!entry.requires.length && (
                        <span>
                          {t("sshImport.via", {
                            names: entry.requires
                              .map(
                                (id) => preview.entries.find((host) => host.id === id)?.name ?? id,
                              )
                              .join(" → "),
                          })}
                        </span>
                      )}
                    </span>
                  </label>
                </div>
              ))}
            </div>
            {!!preview.document.proxies.length && (
              <p className="td-field__hint">
                {t("hostTransfer.proxies", {
                  names: preview.document.proxies
                    .filter((proxy) =>
                      preview.document.hosts.some(
                        (host) => selected.has(host.id) && host.route.proxy === proxy.id,
                      ),
                    )
                    .map((proxy) => proxy.name)
                    .join(", "),
                })}
              </p>
            )}
            {preview.document.mountRules
              .filter((rule) => selected.has(rule.hostId))
              .map((rule) => (
                <label className="ssh-import__details" key={rule.id}>
                  {t("hostTransfer.mountPoint", { name: rule.name })}
                  <Input
                    value={mountPoints[rule.id] ?? rule.mountPoint}
                    disabled={busy}
                    onChange={(event) =>
                      setMountPoints((current) => ({ ...current, [rule.id]: event.target.value }))
                    }
                  />
                </label>
              ))}
          </>
        )}
        {error && <p role="alert">{error}</p>}
      </div>
    </Dialog>
  );
}
