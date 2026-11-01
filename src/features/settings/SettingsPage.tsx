import { FileCode2, FolderOpen, RotateCcw, Search, X } from "lucide-react";
import {
  Fragment,
  lazy,
  Suspense,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import { useTranslation } from "react-i18next";
import { Button, IconButton } from "@/components/ui/form/Button";
import { Input, Switch, Textarea } from "@/components/ui/form/Field";
import { Select } from "@/components/ui/form/Select";
import { ColorPicker } from "@/components/ui/form/ColorPicker";
import { validateUserCss } from "@/lib/prefs/appearance";
import { createDefaultSettings, ACCENT_SWATCHES } from "@/lib/prefs/defaults";
import type { Settings, SettingsPatch } from "@/lib/api/types";
import { translateError } from "@/lib/api/errors";
import { api, isTauri } from "@/lib/api/ipc";
import { cn, formatDateTime } from "@/lib/text/format";
import { toast } from "@/store/toasts";
import { useSettings } from "@/store/settings";
import { useUpdates } from "@/store/updates";
import { useWorkspace } from "@/store/workspace";
import { useDialogs } from "@/store/dialogs";
import { useNavigation, type SettingsSection } from "@/store/navigation";
import {
  SECTION_LABELS,
  SETTINGS_CATALOG,
  SETTINGS_SECTIONS,
  SETTINGS_GROUPS,
  groupSettings,
  type SettingDefinition,
  type SettingOption,
} from "./catalog";
import { NumberPreference } from "./NumberPreference";
import { RegionColors } from "./RegionColors";
import { COLOR_REGIONS, previewColors, resolveAccent } from "@/lib/prefs/colors";
import type { ResolvedTheme } from "@/lib/prefs/appearance";
import { useResolvedTheme } from "@/lib/prefs/useResolvedTheme";
import { PluginSettingsSection } from "@/features/plugins/PluginSettingsSection";

const samePreference = (left: unknown, right: unknown) =>
  typeof left === "object" && left !== null && typeof right === "object" && right !== null
    ? Object.keys(left).length === Object.keys(right).length &&
      Object.entries(left).every(
        ([key, value]) => (right as Record<string, unknown>)[key] === value,
      )
    : left === right;

const TerminalPreview = lazy(() =>
  import("@/features/terminal/TerminalPreview").then((module) => ({
    default: module.TerminalPreview,
  })),
);

function PreferenceRow({
  definition,
  settings,
  defaults,
  onReset,
  resetVersion,
  theme,
}: {
  definition: SettingDefinition;
  settings: Settings;
  defaults: Settings;
  onReset: () => void;
  resetVersion: number;
  theme: ResolvedTheme;
}) {
  const { t } = useTranslation();
  const descriptionId = useId();
  const update = useSettings((state) => state.update);
  const label = t(definition.label);
  const value = settings[definition.key];
  const defaultValue = defaults[definition.key];
  const modified = !samePreference(value, defaultValue);
  const disabled = definition.dependsOn ? !settings[definition.dependsOn] : false;
  const setValue = (next: string | number | boolean) =>
    void update({ [definition.key]: next } as SettingsPatch);
  const optionLabel = (option: SettingOption) => (option.literal ? option.label : t(option.label));
  const formatValue = (next: Settings[typeof definition.key]) => {
    if (typeof next === "boolean") return t(next ? "settings.enabled" : "settings.disabled");
    if (definition.kind === "colors") return t("color.themeDefault");
    const option = definition.options?.find((item) => item.value === next);
    if (option) return optionLabel(option);
    if (definition.kind === "accent") {
      const swatch = ACCENT_SWATCHES.find((item) => item.id === next);
      if (swatch) return t(swatch.labelKey);
    }
    return `${next}${definition.unit ? ` ${definition.unit}` : ""}`;
  };
  return (
    <div
      className={cn(
        "settings-row",
        definition.kind === "colors" && "settings-row--colors",
        modified && "is-modified",
        disabled && "is-disabled",
      )}
      data-setting={definition.key}
    >
      <div className="settings-row__text" id={descriptionId}>
        <span className="settings-row__label">
          {label}
          {modified ? (
            <span
              className="settings-row__modified"
              title={t("settings.modified")}
              aria-label={t("settings.modified")}
            />
          ) : null}
        </span>
        {definition.hint ? <span className="settings-row__hint">{t(definition.hint)}</span> : null}
        <span className="settings-row__default">
          {t("settings.defaultValue", { value: formatValue(defaultValue) })}
          {definition.kind === "number"
            ? ` · ${t("settings.valueRange", { min: definition.min, max: definition.max })}`
            : ""}
        </span>
      </div>
      <div
        className="settings-row__control"
        aria-describedby={definition.hint ? descriptionId : undefined}
      >
        {definition.kind === "toggle" ? (
          <Switch
            label={label}
            checked={Boolean(value)}
            disabled={disabled}
            onChange={setValue}
            descriptionId={descriptionId}
          />
        ) : null}
        {definition.kind === "number" ? (
          <NumberPreference
            key={resetVersion}
            label={label}
            descriptionId={descriptionId}
            value={Number(value)}
            min={definition.min!}
            max={definition.max!}
            step={definition.step}
            unit={definition.unit}
            disabled={disabled}
            onChange={setValue}
          />
        ) : null}
        {definition.kind === "select" ? (
          <Select
            label={label}
            descriptionId={descriptionId}
            value={String(value)}
            disabled={disabled}
            options={definition.options!.map((option) => ({
              value: String(option.value),
              label: optionLabel(option),
            }))}
            onChange={(next) => setValue(typeof defaultValue === "number" ? Number(next) : next)}
          />
        ) : null}
        {definition.kind === "accent" ? (
          <ColorPicker
            label={label}
            value={String(value)}
            defaultValue={String(defaultValue)}
            presets={ACCENT_SWATCHES.map((preset) => ({
              value: preset.id,
              label: t(preset.labelKey),
              color: resolveAccent(preset.id, theme),
            }))}
            onChange={setValue}
            onPreview={(accent) => previewColors(accent ? { accent } : null)}
          />
        ) : null}
        <IconButton
          className="settings-reset"
          size="sm"
          label={t("settings.restoreOne", { name: label })}
          disabled={!modified}
          onClick={onReset}
        >
          <RotateCcw size={13} />
        </IconButton>
      </div>
      {definition.kind === "colors" ? <RegionColors settings={settings} /> : null}
    </div>
  );
}

function CssEditor({
  draft,
  onDraft,
}: {
  draft: string | null;
  onDraft: Dispatch<SetStateAction<string | null>>;
}) {
  const { t } = useTranslation();
  const value = useSettings((state) => state.settings.userCss);
  const update = useSettings((state) => state.update);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const text = draft ?? value;
  const apply = async () => {
    if (applying) return;
    const submitted = text;
    if (!validateUserCss(submitted).ok) {
      setError(t("settings.cssRejected"));
      return;
    }
    setApplying(true);
    try {
      if (await update({ userCss: submitted })) {
        onDraft((current) => (current === submitted ? null : current));
        setError(null);
      }
    } finally {
      setApplying(false);
    }
  };
  const importFile = async () => {
    try {
      const imported = await api.importCss();
      if (imported !== null) {
        onDraft(imported);
        setError(null);
      }
    } catch (failure) {
      toast(translateError(failure), "error");
    }
  };
  const exportFile = async () => {
    try {
      const path = await api.exportCss(text);
      if (path) toast(t("toast.cssExported", { path }), "success");
    } catch (failure) {
      toast(translateError(failure), "error");
    }
  };
  return (
    <div className="settings-css-editor">
      <Textarea
        aria-label={t("settings.customCss")}
        className="settings-css"
        spellCheck={false}
        rows={10}
        value={text}
        placeholder={t("settings.customCssPlaceholder")}
        onChange={(event) => {
          onDraft(event.target.value);
          setError(null);
        }}
      />
      {draft !== null && draft !== value ? (
        <p className="settings-row__hint" role="status">
          {t("settings.cssDraft")}
        </p>
      ) : null}
      {error ? (
        <p className="settings-message is-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="settings-actions">
        <Button
          variant="primary"
          disabled={applying || text === value}
          onClick={() => void apply()}
        >
          {t("common.apply")}
        </Button>
        <Button
          leading={<FileCode2 size={14} />}
          disabled={!isTauri()}
          onClick={() => void importFile()}
        >
          {t("common.import")}
        </Button>
        <Button variant="ghost" disabled={!isTauri()} onClick={() => void exportFile()}>
          {t("common.export")}
        </Button>
        {draft !== null ? (
          <Button
            variant="ghost"
            onClick={() => {
              onDraft(null);
              setError(null);
            }}
          >
            {t("settings.discardDraft")}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

export function SettingsPage() {
  const { t, i18n } = useTranslation();
  const settings = useSettings((state) => state.settings);
  const theme = useResolvedTheme(settings.theme);
  const info = useSettings((state) => state.info);
  const error = useSettings((state) => state.error);
  const saving = useSettings((state) => state.saving);
  const update = useSettings((state) => state.update);
  const reset = useSettings((state) => state.reset);
  const confirm = useDialogs((state) => state.confirm);
  const section = useNavigation((state) => state.settingsSection);
  const selectSection = useNavigation((state) => state.selectSettings);
  const openPage = useWorkspace((state) => state.openPage);
  const [query, setQuery] = useState("");
  const [modifiedOnly, setModifiedOnly] = useState(false);
  const [cssDraft, setCssDraft] = useState<string | null>(null);
  const [resetVersions, setResetVersions] = useState<Record<string, number>>({});
  const body = useRef<HTMLDivElement>(null);
  const settingsId = useId();
  useLayoutEffect(() => {
    if (body.current) body.current.scrollTop = 0;
  }, [section, query, modifiedOnly]);
  const clearNumberDrafts = (keys: readonly string[]) =>
    setResetVersions((previous) => {
      const next = { ...previous };
      for (const key of keys) next[key] = (next[key] ?? 0) + 1;
      return next;
    });
  const defaults = info?.defaultSettings ?? createDefaultSettings(info?.os);
  const filtering = Boolean(query.trim()) || modifiedOnly;
  const definitions = SETTINGS_CATALOG.filter((item) => !(item.hideOnMac && info?.os === "macos"));
  const isModified = (item: SettingDefinition) =>
    !samePreference(settings[item.key], defaults[item.key]) ||
    (item.key === "userCss" && cssDraft !== null && cssDraft !== settings.userCss);
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const visible = definitions.filter((item) => {
    if (!filtering && item.section !== section) return false;
    if (modifiedOnly && !isModified(item)) return false;
    const text = [
      item.key,
      ...["en-US", "zh-CN"].flatMap((language) => {
        const translate = i18n.getFixedT(language);
        return [
          translate(item.label),
          translate(SECTION_LABELS[item.section]),
          ...(SETTINGS_GROUPS[item.section] ?? [])
            .filter((group) => group.keys.includes(item.key))
            .map((group) => translate(group.label)),
          item.hint ? translate(item.hint) : "",
          ...(item.key === "colors"
            ? COLOR_REGIONS.map((region) => translate(`color.region.${region}`))
            : []),
          ...(item.options ?? []).map((option) =>
            option.literal ? option.label : translate(option.label),
          ),
        ];
      }),
    ]
      .join(" ")
      .toLocaleLowerCase();
    return words.every((word) => text.includes(word));
  });
  const resetOne = (definition: SettingDefinition) => {
    clearNumberDrafts([definition.key]);
    if (definition.key === "userCss") setCssDraft(null);
    void update({ [definition.key]: defaults[definition.key] } as SettingsPatch);
  };
  const resetSection = (target: SettingsSection) => {
    const items = definitions.filter((item) => item.section === target);
    confirm({
      title: t("settings.restoreSection", { name: t(SECTION_LABELS[target]) }),
      body: t("settings.restoreSectionConfirm", { name: t(SECTION_LABELS[target]) }),
      confirmLabel: t("common.reset"),
      onConfirm: () => {
        clearNumberDrafts(items.map((definition) => definition.key));
        if (target === "advanced") setCssDraft(null);
        void update(
          Object.fromEntries(items.map((item) => [item.key, defaults[item.key]])) as SettingsPatch,
        );
      },
    });
  };
  const clearFilters = () => {
    setQuery("");
    setModifiedOnly(false);
  };
  const showSection = (target: SettingsSection) => {
    selectSection(target);
    clearFilters();
  };
  const locale = i18n.resolvedLanguage ?? "en-US";
  return (
    <div className="page settings">
      <div className="settings-toolbar">
        <div className="settings-search">
          <Search size={15} aria-hidden="true" />
          <Input
            aria-label={t("settings.search")}
            placeholder={t("settings.search")}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          {query ? (
            <IconButton size="sm" label={t("settings.clearSearch")} onClick={() => setQuery("")}>
              <X size={13} />
            </IconButton>
          ) : null}
        </div>
        <label className="settings-modified-filter">
          <input
            type="checkbox"
            checked={modifiedOnly}
            onChange={(event) => setModifiedOnly(event.target.checked)}
          />
          {t("settings.modifiedOnly")}
          <span>{definitions.filter(isModified).length}</span>
        </label>
      </div>
      <div className="settings-save-state" role="status">
        {error ? (
          <span className="settings-message is-error">{error}</span>
        ) : (
          t(saving ? "settings.saving" : "settings.autoSavedHint")
        )}
      </div>
      <div className="settings__content">
        <nav className="settings__nav" aria-label={t("settings.title")}>
          {SETTINGS_SECTIONS.map((item) => (
            <Fragment key={item}>
              <button
                type="button"
                className={cn("settings__nav-item", !filtering && item === section && "is-active")}
                aria-current={!filtering && item === section ? "page" : undefined}
                onClick={() => showSection(item)}
              >
                {t(SECTION_LABELS[item])}
              </button>
              {!filtering && item === section
                ? (SETTINGS_GROUPS[item] ?? []).map((group) => (
                    <button
                      type="button"
                      key={group.id}
                      className="settings__nav-item settings__nav-item--child"
                      aria-controls={`${settingsId}-${group.id}`}
                      onClick={() =>
                        document
                          .getElementById(`${settingsId}-${group.id}`)
                          ?.scrollIntoView({ block: "start" })
                      }
                    >
                      {t(group.label)}
                    </button>
                  ))
                : null}
            </Fragment>
          ))}
        </nav>
        <div className="settings__body" ref={body}>
          {filtering ? (
            <div className="settings-results">
              <span>{t("settings.resultCount", { count: visible.length })}</span>
              <Button size="sm" variant="ghost" onClick={clearFilters}>
                {t("settings.clearFilters")}
              </Button>
            </div>
          ) : null}
          {SETTINGS_SECTIONS.filter(
            (item) =>
              visible.some((definition) => definition.section === item) ||
              (!filtering && item === section),
          ).map((item) => (
            <section className="settings-section" key={item} aria-label={t(SECTION_LABELS[item])}>
              <div className="settings-section__head">
                <h2 className="settings-section__title">{t(SECTION_LABELS[item])}</h2>
                {item !== "plugins" ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={
                      !definitions.some(
                        (definition) => definition.section === item && isModified(definition),
                      )
                    }
                    leading={<RotateCcw size={13} />}
                    onClick={() => resetSection(item)}
                  >
                    {t("settings.restoreCategory")}
                  </Button>
                ) : null}
              </div>
              <div className="settings-section__body">
                {item === "plugins" && !filtering ? <PluginSettingsSection /> : null}
                {item === "terminal" && !filtering ? (
                  <Suspense fallback={<p className="settings-row__hint">{t("common.loading")}</p>}>
                    <TerminalPreview />
                  </Suspense>
                ) : null}
                {groupSettings(
                  item,
                  visible.filter((definition) => definition.section === item),
                ).map((group) => (
                  <div
                    key={group.id}
                    id={`${settingsId}-${group.id}`}
                    className={group.label ? "settings-preference-group" : undefined}
                    data-settings-group={group.id}
                  >
                    {group.label ? (
                      <h3 className="settings-preference-group__title">{t(group.label)}</h3>
                    ) : null}
                    <div className={group.label ? "settings-preference-group__body" : undefined}>
                      {group.definitions.map((definition) =>
                        definition.kind === "css" ? (
                          <div
                            key={definition.key}
                            className="settings-css-group"
                            data-setting="userCss"
                          >
                            <div className="settings-section__head">
                              <span>{t(definition.label)}</span>
                              <IconButton
                                size="sm"
                                label={t("settings.restoreOne", { name: t(definition.label) })}
                                disabled={!isModified(definition)}
                                onClick={() => resetOne(definition)}
                              >
                                <RotateCcw size={13} />
                              </IconButton>
                            </div>
                            <p className="settings-row__hint">
                              {t(definition.hint!)} ·{" "}
                              {t("settings.defaultValue", { value: t("settings.cssEmpty") })}
                            </p>
                            <CssEditor draft={cssDraft} onDraft={setCssDraft} />
                          </div>
                        ) : (
                          <PreferenceRow
                            key={definition.key}
                            definition={definition}
                            settings={settings}
                            defaults={defaults}
                            onReset={() => resetOne(definition)}
                            resetVersion={resetVersions[definition.key] ?? 0}
                            theme={theme}
                          />
                        ),
                      )}
                    </div>
                  </div>
                ))}
                {!filtering && item === "updates" ? (
                  <>
                    <p className="settings-detail">
                      {t("settings.version")}: {info?.version ?? "—"} · {t("updates.lastChecked")}:{" "}
                      {settings.lastUpdateCheck
                        ? formatDateTime(settings.lastUpdateCheck, locale)
                        : t("common.never")}
                    </p>
                    <div className="settings-actions">
                      <Button
                        onClick={() => {
                          openPage("updates");
                          void useUpdates.getState().check(true);
                        }}
                      >
                        {t("updates.check")}
                      </Button>
                    </div>
                  </>
                ) : null}
                {!filtering && item === "advanced" ? (
                  <>
                    <div className="settings-locations">
                      {(
                        [
                          ["settings.dataDir", info?.dataDir, api.openDataDir],
                          ["settings.logDir", info?.logDir, api.openLogDir],
                        ] as const
                      ).map(([key, path, open]) => (
                        <div className="settings-location" key={key}>
                          <span>{t(key)}</span>
                          <code title={path}>{path ?? "—"}</code>
                          <IconButton
                            size="sm"
                            label={t(
                              key === "settings.dataDir"
                                ? "settings.openData"
                                : "settings.openLogs",
                            )}
                            disabled={!isTauri()}
                            onClick={() =>
                              void open().catch((failure) =>
                                toast(translateError(failure), "error"),
                              )
                            }
                          >
                            <FolderOpen size={14} />
                          </IconButton>
                        </div>
                      ))}
                    </div>
                    <div className="settings-actions">
                      <Button
                        variant="ghost-danger"
                        leading={<RotateCcw size={14} />}
                        onClick={() =>
                          confirm({
                            title: t("settings.resetAll"),
                            body: t("settings.resetConfirm"),
                            confirmLabel: t("common.reset"),
                            danger: true,
                            onConfirm: () => {
                              clearNumberDrafts(definitions.map((definition) => definition.key));
                              setCssDraft(null);
                              void reset();
                            },
                          })
                        }
                      >
                        {t("settings.resetAll")}
                      </Button>
                    </div>
                  </>
                ) : null}
              </div>
            </section>
          ))}
          {filtering && visible.length === 0 ? (
            <div className="settings-empty">
              <Search size={24} aria-hidden="true" />
              <p>{t("common.noResults")}</p>
              <Button variant="ghost" onClick={clearFilters}>
                {t("settings.clearFilters")}
              </Button>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
