import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/form/Button";
import { Dialog } from "@/components/ui/overlay/Dialog";
import { api } from "@/lib/api/ipc";
import { translateError } from "@/lib/api/errors";
import type { SshConfigIssue, SshConfigPreview } from "@/lib/api/sshConfig";
import { useBackgroundGuard } from "@/lib/session/viewState";
import { useHosts } from "@/store/hosts";
import { toast } from "@/store/toasts";
import "./sshConfigImport.css";

export function SshConfigImportDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const [preview, setPreview] = useState<SshConfigPreview | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useBackgroundGuard(true);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    setPreview(null);
    void api
      .sshConfigPreview()
      .then((result) => {
        if (!active) return;
        setPreview(result);
        setSelected(
          new Set(
            result.entries
              .filter((entry) => entry.input && !entry.existingId && entry.issues.length === 0)
              .map((entry) => entry.alias),
          ),
        );
      })
      .catch((cause: unknown) => {
        if (active) setError(translateError(cause));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [attempt]);

  const importSelected = async () => {
    if (!preview || saving || loading || selected.size === 0) return;
    setSaving(true);
    setError(null);
    try {
      const result = await api.sshConfigImport([...selected], preview.revision);
      for (const host of result.imported) useHosts.getState().receiveSavedHost(host);
      await useHosts.getState().load();
      toast(t("sshImport.imported", { count: result.imported.length }), "success");
      onClose();
    } catch (cause) {
      setError(translateError(cause));
    } finally {
      setSaving(false);
    }
  };
  const issueText = (issue: SshConfigIssue) =>
    t(`sshImport.issue.${issue.code}`, { detail: issue.detail });

  return (
    <Dialog
      open
      title={t("sshImport.title")}
      closeLabel={t("common.close")}
      onClose={onClose}
      dismissible={!saving}
      width={560}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            {t("common.cancel")}
          </Button>
          <Button onClick={() => setAttempt((value) => value + 1)} disabled={saving || loading}>
            {t("sshImport.refresh")}
          </Button>
          <Button
            variant="primary"
            disabled={saving || loading || !preview?.found || selected.size === 0}
            onClick={() => void importSelected()}
          >
            {saving
              ? t("sshImport.importing")
              : t("sshImport.importSelected", { count: selected.size })}
          </Button>
        </>
      }
    >
      <div className="ssh-import" aria-busy={loading || saving}>
        <p className="td-field__hint">{t("sshImport.description")}</p>
        {preview ? <p className="ssh-import__path">{preview.path}</p> : null}
        {loading ? <p role="status">{t("sshImport.loading")}</p> : null}
        {error ? <p role="alert">{error}</p> : null}
        {preview && !preview.found ? <p>{t("sshImport.notFound")}</p> : null}
        {preview?.found && preview.entries.length === 0 ? <p>{t("sshImport.empty")}</p> : null}
        {preview?.issues.length ? (
          <ul className="ssh-import__issues">
            {preview.issues.map((issue, index) => (
              <li key={index}>{issueText(issue)}</li>
            ))}
          </ul>
        ) : null}
        {preview?.entries.length ? (
          <div className="ssh-import__entries">
            {preview.entries.map((entry) => {
              const eligible = !!entry.input && !entry.existingId && entry.issues.length === 0;
              return (
                <label key={entry.alias} className="ssh-import__entry">
                  <input
                    type="checkbox"
                    checked={selected.has(entry.alias)}
                    disabled={saving || !eligible}
                    onChange={(event) => {
                      const checked = event.currentTarget.checked;
                      setSelected((current) => {
                        const next = new Set(current);
                        if (checked) next.add(entry.alias);
                        else next.delete(entry.alias);
                        return next;
                      });
                    }}
                  />
                  <span className="ssh-import__details">
                    <span className="ssh-import__alias">{entry.alias}</span>
                    {entry.input ? (
                      <span className="ssh-import__address">
                        {entry.input.username}@{entry.input.host}:{entry.input.port ?? 22}
                      </span>
                    ) : null}
                    {entry.existingId ? <span>{t("sshImport.existing")}</span> : null}
                    {entry.jumpAliases.length ? (
                      <span>{t("sshImport.via", { names: entry.jumpAliases.join(" → ") })}</span>
                    ) : null}
                    {entry.issues.map((issue, index) => (
                      <span key={index}>{issueText(issue)}</span>
                    ))}
                  </span>
                </label>
              );
            })}
          </div>
        ) : null}
        {preview?.entries.some((entry) => entry.jumpAliases.length > 0) ? (
          <p className="td-field__hint">{t("sshImport.dependencies")}</p>
        ) : null}
      </div>
    </Dialog>
  );
}
