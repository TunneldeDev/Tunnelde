import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pencil, Plus, Trash2 } from "lucide-react";

import { Button, IconButton } from "@/components/ui/form/Button";
import { Input, Switch } from "@/components/ui/form/Field";
import { Dialog } from "@/components/ui/overlay/Dialog";
import { api } from "@/lib/api/ipc";
import type { MarketSource } from "@/lib/api/types";
import { translateError } from "@/lib/api/errors";
import { useMarketplace } from "@/store/marketplace";
import { useDialogs } from "@/store/dialogs";
import { toast } from "@/store/toasts";
import { NodeRuntimeSection } from "./NodeRuntimeSection";
import { PluginError } from "./PluginError";
import { PluginSecuritySection } from "./PluginSecuritySection";

export function PluginSettingsSection() {
  const { t } = useTranslation();
  const config = useMarketplace((s) => s.config);
  const configError = useMarketplace((s) => s.configError);
  const configLoading = useMarketplace((s) => s.configLoading);
  const ready = useMarketplace((s) => s.ready);
  const load = useMarketplace((s) => s.load);
  const saveSources = useMarketplace((s) => s.saveSources);
  const [edit, setEdit] = useState<MarketSource | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const saveLock = useRef(false);
  const disabled = saving || configLoading || !ready;
  useEffect(() => {
    void load();
  }, [load]);
  const save = async (sources: MarketSource[]) => {
    if (saveLock.current) throw new Error(t("market.busy"));
    saveLock.current = true;
    setSaving(true);
    setSaveError(null);
    try {
      await saveSources(sources);
    } catch (error) {
      setSaveError(translateError(error));
      toast(translateError(error), "error");
      throw error;
    } finally {
      setSaving(false);
      saveLock.current = false;
    }
  };
  return (
    <div className="plugin-settings">
      <PluginSecuritySection />
      <section className="settings-subsection" aria-label={t("market.sources")}>
        <div className="settings-section__head">
          <h3 className="settings-subtitle">{t("market.sources")}</h3>
          <Button
            size="sm"
            leading={<Plus size={13} />}
            disabled={disabled}
            onClick={() =>
              setEdit({
                id: `source-${crypto.randomUUID().slice(0, 12)}`,
                name: "",
                url: "",
                enabled: true,
              })
            }
          >
            {t("market.addSource")}
          </Button>
        </div>
        <p className="settings-hint">{t("market.sourcesHint")}</p>
        {configError ? (
          <div>
            <PluginError message={configError} />
            <Button size="sm" disabled={configLoading} onClick={() => void load(true)}>
              {t("market.retry")}
            </Button>
          </div>
        ) : null}
        {saveError ? <PluginError message={saveError} /> : null}
        {configLoading ? <p role="status">{t("common.loading")}</p> : null}
        <div className="plugin-sources">
          {config.sources.map((source) => (
            <article className="plugin-source" key={source.id}>
              <div className="plugin-source__identity">
                <strong>{source.name}</strong>
                {source.id === "official" ? (
                  <span className="plugin-badge">{t("market.official")}</span>
                ) : null}
                <p title={source.url}>{source.url}</p>
              </div>
              <Switch
                label={source.name}
                checked={source.enabled}
                disabled={disabled}
                onChange={(enabled) =>
                  void save(
                    config.sources.map((s) => (s.id === source.id ? { ...s, enabled } : s)),
                  ).catch(() => undefined)
                }
              />
              {source.id !== "official" ? (
                <>
                  <IconButton
                    label={t("market.editSource")}
                    size="sm"
                    disabled={disabled}
                    onClick={() => setEdit(source)}
                  >
                    <Pencil size={13} />
                  </IconButton>
                  <IconButton
                    label={t("market.removeSource")}
                    size="sm"
                    danger
                    disabled={disabled}
                    onClick={() =>
                      useDialogs.getState().confirm({
                        title: t("market.removeSource"),
                        body: t("market.removeSourceBody", { name: source.name }),
                        confirmLabel: t("common.delete"),
                        danger: true,
                        onConfirm: () =>
                          save(
                            useMarketplace
                              .getState()
                              .config.sources.filter((s) => s.id !== source.id),
                          ).catch(() => undefined),
                      })
                    }
                  >
                    <Trash2 size={13} />
                  </IconButton>
                </>
              ) : null}
            </article>
          ))}
        </div>
      </section>
      <NodeRuntimeSection />
      {edit ? (
        <SourceDialog
          key={edit.id}
          initial={edit}
          onClose={() => setEdit(null)}
          onSave={async (source) => {
            const current = useMarketplace.getState().config.sources;
            await save(
              current.some((s) => s.id === source.id)
                ? current.map((s) => (s.id === source.id ? source : s))
                : [...current, source],
            );
            setEdit(null);
          }}
        />
      ) : null}
    </div>
  );
}

function SourceDialog({
  initial,
  onClose,
  onSave,
}: {
  initial: MarketSource;
  onClose: () => void;
  onSave: (source: MarketSource) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState(initial.name),
    [url, setUrl] = useState(initial.url);
  const [error, setError] = useState<string | null>(null),
    [testing, setTesting] = useState(false),
    [result, setResult] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const alive = useRef(true);
  const commitLock = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const source = { ...initial, name: name.trim(), url: url.trim() };
  const valid = () => {
    try {
      const parsed = new URL(source.url);
      if (
        parsed.protocol !== "https:" ||
        parsed.username ||
        parsed.password ||
        parsed.hash ||
        source.url.length > 4096
      )
        throw new Error();
    } catch {
      setError(t("market.invalidUrl"));
      return false;
    }
    if (!source.name || source.name.length > 120) {
      setError(t("market.invalidSource"));
      return false;
    }
    if (
      useMarketplace
        .getState()
        .config.sources.some((s) => s.id !== source.id && s.url === source.url)
    ) {
      setError(t("market.duplicateSource"));
      return false;
    }
    setError(null);
    return true;
  };
  const submit = async () => {
    if (saving || testing || !valid()) return;
    const commit = async () => {
      if (!alive.current || commitLock.current) return;
      commitLock.current = true;
      setSaving(true);
      try {
        await onSave(source);
      } catch (e) {
        if (alive.current) setError(translateError(e));
      } finally {
        commitLock.current = false;
        if (alive.current) setSaving(false);
      }
    };
    if (initial.url !== source.url)
      useDialogs.getState().confirm({
        title: t("market.trustTitle"),
        body: t("market.trustBody", { name: source.name, url: source.url }),
        confirmLabel: t("market.trust"),
        onConfirm: commit,
      });
    else await commit();
  };
  return (
    <Dialog
      open
      title={t(initial.url ? "market.editSource" : "market.addSource")}
      closeLabel={t("common.close")}
      onClose={onClose}
      dismissible={!saving}
      width={560}
      footer={
        <>
          <Button onClick={onClose} disabled={saving}>
            {t("common.cancel")}
          </Button>
          <Button variant="primary" disabled={saving || testing} onClick={() => void submit()}>
            {t("common.save")}
          </Button>
        </>
      }
    >
      <form
        className="plugin-source-form"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <label>
          {t("market.sourceName")}
          <Input
            autoFocus
            value={name}
            maxLength={120}
            disabled={saving || testing}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label>
          {t("market.sourceUrl")}
          <Input
            value={url}
            placeholder="https://…/index.json"
            disabled={saving || testing}
            onChange={(e) => {
              setUrl(e.target.value);
              setResult(null);
            }}
          />
        </label>
        <Button
          size="sm"
          disabled={saving || testing}
          onClick={() => {
            if (!valid()) return;
            setTesting(true);
            void api
              .pluginSourceTest(source.url)
              .then((count) => {
                if (alive.current) setResult(count);
              })
              .catch((e) => {
                if (alive.current) setError(translateError(e));
              })
              .finally(() => {
                if (alive.current) setTesting(false);
              });
          }}
        >
          {t(testing ? "common.loading" : "market.testSource")}
        </Button>
        {result !== null ? <p role="status">{t("market.testSuccess", { count: result })}</p> : null}
        {error ? <PluginError message={error} /> : null}
      </form>
    </Dialog>
  );
}
