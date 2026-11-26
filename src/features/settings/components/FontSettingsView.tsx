import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/form/Button";
import { Select } from "@/components/ui/form/Select";
import { previewFont, FONT_READY_EVENT, fontFamily } from "@/lib/fonts/runtime";
import {
  DEFAULT_FONT_SELECTIONS,
  fontKey,
  sameFont,
  type FontCatalogue,
  type FontInfo,
  type FontReference,
  type FontSelections,
} from "@/lib/fonts/types";
import type { Settings } from "@/lib/api/types";
import { monoStack } from "@/lib/prefs/appearance";
import { reportError } from "@/lib/diagnostics";
import { translateError } from "@/lib/api/errors";
import type { ConfirmOptions } from "@/store/dialogs";
import type { SettingsControlState } from "./controlState";
import "../fontSettings.css";

export interface FontSettingsServices {
  catalogue(refresh?: boolean): Promise<FontCatalogue>;
  importFile(): Promise<FontInfo | null>;
  remove(id: string): Promise<void>;
  select(target: keyof FontSelections, reference: FontReference | null): Promise<void>;
  confirm(options: ConfirmOptions): void;
  useViewState: SettingsControlState;
}

const TARGETS = ["ui", "mono", "editorCjk"] as const;

export function FontSettingsView({
  settings,
  services,
  live = true,
}: {
  settings: Settings;
  services: FontSettingsServices;
  live?: boolean;
}) {
  const { t } = useTranslation();
  const [items, setItems] = useState<FontInfo[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [query, setQuery] = services.useViewState("fonts:query", "");
  const [monoOnly, setMonoOnly] = services.useViewState("fonts:monoOnly", false);
  const [previewKey, setPreviewKey] = services.useViewState("fonts:preview", "");
  const [previewState, setPreview] = useState<{
    key: string;
    family: string;
    monospaced: boolean;
  } | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [catalogueError, setCatalogueError] = useState("");
  const mounted = useRef(false);
  const catalogueRequest = useRef(0);
  const operation = useRef(false);
  const selections = settings.fontSelections ?? DEFAULT_FONT_SELECTIONS;
  const catalogue = services.catalogue;

  const refresh = useCallback(
    async (force = false) => {
      const request = ++catalogueRequest.current;
      try {
        const result = await catalogue(force);
        if (mounted.current && request === catalogueRequest.current) {
          setItems(result.items);
          setCatalogueError("");
        }
      } catch (cause) {
        if (mounted.current && request === catalogueRequest.current) {
          reportError("fonts", "loadCatalogue", cause);
          setCatalogueError(translateError(cause));
        }
      }
    },
    [catalogue],
  );

  useEffect(() => {
    mounted.current = true;
    // A staged or moving Settings tree cannot call the live window owner.
    const load = () => void refresh();
    if (live) {
      load();
      window.addEventListener(FONT_READY_EVENT, load);
    }
    return () => {
      mounted.current = false;
      catalogueRequest.current++;
      window.removeEventListener(FONT_READY_EVENT, load);
    };
  }, [live, refresh]);

  const candidate = items.find((font) => fontKey(font.reference) === previewKey);
  const preview = candidate && previewState?.key === previewKey ? previewState : null;
  useEffect(() => {
    let disposed = false;
    let release: (() => void) | undefined;
    if (candidate) {
      void previewFont(candidate.reference)
        .then((loaded) => {
          if (disposed) {
            loaded.dispose();
            return;
          }
          release = loaded.dispose;
          setPreviewError(null);
          setPreview({ key: previewKey, family: loaded.family, monospaced: loaded.monospaced });
        })
        .catch((cause) => {
          if (!disposed) {
            reportError("fonts", "preview", cause, "warn");
            setPreview(null);
            setPreviewError(previewKey);
          }
        });
    }
    return () => {
      disposed = true;
      release?.();
    };
  }, [candidate, previewKey]);

  const run = async (action: () => Promise<unknown>) => {
    if (!live || operation.current) return;
    operation.current = true;
    setPending(true);
    setError("");
    try {
      await action();
    } catch (cause) {
      reportError("fonts", "update", cause);
      if (mounted.current) setError(translateError(cause));
    } finally {
      operation.current = false;
      if (mounted.current) setPending(false);
    }
  };
  const choose = async (target: keyof FontSelections, key: string) => {
    const reference = items.find((font) => fontKey(font.reference) === key)?.reference ?? null;
    await services.select(target, reference);
  };
  const sourceLabel = (font: FontInfo) =>
    t(font.reference.source === "system" ? "fonts.system" : "fonts.imported");
  const options = items
    .filter(
      (font) =>
        (!monoOnly || font.monospaced) &&
        `${font.name} ${sourceLabel(font)}`
          .toLocaleLowerCase()
          .includes(query.toLocaleLowerCase().trim()),
    )
    .map((font) => ({
      value: fontKey(font.reference),
      label: `${sourceLabel(font)} · ${font.name}`,
    }));
  const previewOptions = [{ value: "", label: t("fonts.selectPreview") }, ...options];
  if (candidate && !previewOptions.some((option) => option.value === previewKey))
    previewOptions.push({
      value: previewKey,
      label: `${sourceLabel(candidate)} · ${candidate.name}`,
    });
  const sample =
    "01234567890123456789\n中英文对齐繁體中文日本\nAaBb ()[]{} <> /\\ =+-_\n┌────┬────┐";

  return (
    <div className="font-settings" data-setting="fontSelections" aria-label={t("fonts.title")}>
      <p className="settings-row__hint">{t("fonts.hint")}</p>
      {TARGETS.map((target) => {
        const current = selections[target];
        const currentKey = fontKey(current);
        const font = items.find((item) => sameFont(item.reference, current));
        const choices = [
          { value: "", label: t(target === "editorCjk" ? "fonts.automatic" : "fonts.default") },
          ...items.map((item) => ({
            value: fontKey(item.reference),
            label: `${sourceLabel(item)} · ${item.name}`,
          })),
        ];
        if (current && !font)
          choices.push({
            value: currentKey,
            label: `${t("fonts.unavailable")} · ${current.source === "system" ? current.family : current.id.slice(0, 12)}`,
          });
        const family = current ? `${JSON.stringify(fontFamily(current))}, ` : "";
        const fallback =
          target === "ui"
            ? "var(--td-ui-font)"
            : target === "mono"
              ? monoStack(settings.monoFont)
              : '"PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif';
        return (
          <div className="font-settings__choice" key={target}>
            <div className="font-settings__row">
              <span>{t(`fonts.${target}`)}</span>
              <Select
                label={t(`fonts.${target}`)}
                value={currentKey}
                options={choices}
                disabled={pending}
                onChange={(key) => void run(() => choose(target, key))}
              />
              <Button
                size="sm"
                variant="ghost"
                disabled={pending || !current}
                onClick={() => void run(() => choose(target, ""))}
              >
                {t("fonts.reset")}
              </Button>
            </div>
            <p className="font-settings__sample" style={{ fontFamily: `${family}${fallback}` }}>
              AaBb 0123 中英文 繁體 日本語
            </p>
            {current && !font ? (
              <p role="status" className="settings-row__hint">
                {t("fonts.missingHint")}
              </p>
            ) : null}
            {target === "mono" && font && !font.monospaced ? (
              <p className="settings-row__hint">{t("fonts.proportionalHint")}</p>
            ) : null}
          </div>
        );
      })}
      <div className="font-settings__row">
        <input
          type="search"
          className="td-input"
          aria-label={t("fonts.search")}
          placeholder={t("fonts.search")}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <Button size="sm" disabled={pending} onClick={() => void run(() => refresh(true))}>
          {t("fonts.refresh")}
        </Button>
        <Button
          size="sm"
          disabled={pending}
          onClick={() =>
            void run(async () => {
              const font = await services.importFile();
              if (!font) return;
              await refresh();
              if (mounted.current) setPreviewKey(fontKey(font.reference));
            })
          }
        >
          {t("fonts.import")}
        </Button>
      </div>
      <label className="font-settings__filter">
        <input
          type="checkbox"
          checked={monoOnly}
          onChange={(event) => setMonoOnly(event.target.checked)}
        />
        {t("fonts.monoOnly")}
      </label>
      <Select
        label={t("fonts.previewFont")}
        value={previewKey}
        options={previewOptions}
        disabled={pending}
        onChange={setPreviewKey}
      />
      <pre
        className="font-settings__preview"
        aria-label={t("fonts.preview")}
        style={{
          fontFamily: preview ? JSON.stringify(preview.family) : monoStack(settings.monoFont),
        }}
      >
        {sample}
      </pre>
      {previewError === previewKey ? (
        <p role="status" className="settings-row__hint">
          {t("fonts.previewFailed")}
        </p>
      ) : null}
      {preview && !preview.monospaced ? (
        <p className="settings-row__hint">{t("fonts.proportionalHint")}</p>
      ) : null}
      <div className="font-settings__row">
        {TARGETS.map((target) => (
          <Button
            key={target}
            size="sm"
            disabled={pending || !preview || preview.key !== previewKey}
            onClick={() => void run(() => choose(target, previewKey))}
          >
            {t(`fonts.apply${target === "ui" ? "Ui" : target === "mono" ? "Mono" : "Cjk"}`)}
          </Button>
        ))}
      </div>
      {items
        .filter((font) => font.reference.source === "imported")
        .map((font) => (
          <div className="font-settings__row" key={fontKey(font.reference)}>
            <span className="font-settings__name">
              {font.name} · {font.format?.toUpperCase()} ·{" "}
              {((font.bytes ?? 0) / 1024 / 1024).toFixed(2)} MiB
            </span>
            <Button
              size="sm"
              variant="ghost-danger"
              disabled={pending}
              onClick={() => {
                const remove = () =>
                  void run(async () => {
                    if (font.reference.source !== "imported") return;
                    await services.remove(font.reference.id);
                    if (mounted.current && previewKey === fontKey(font.reference))
                      setPreviewKey("");
                    await refresh();
                  });
                if (
                  Object.values(selections).some((reference) => sameFont(reference, font.reference))
                )
                  services.confirm({
                    title: t("fonts.deleteTitle"),
                    body: t("fonts.deleteActive"),
                    confirmLabel: t("fonts.delete"),
                    danger: true,
                    onConfirm: remove,
                  });
                else remove();
              }}
            >
              {t("fonts.delete")}
            </Button>
          </div>
        ))}
      <p className="settings-row__hint">{t("fonts.importHint")}</p>
      {pending ? <p role="status">{t("common.loading")}</p> : null}
      {error || catalogueError ? <p role="alert">{error || catalogueError}</p> : null}
    </div>
  );
}
