import { useShortcutConflicts } from "@/store/shortcutConflicts";
import { AboutPage } from "@/features/about/AboutPage";
import { RotateCcw, Search } from "lucide-react";
import { SearchField } from "@/components/ui/form/SearchField";
import { matchesSearch, parseSearchQuery, toggleSearchFilter } from "@/lib/search/query";
import { Fragment, useId, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/form/Button";
import { createDefaultSettings } from "@/lib/prefs/defaults";
import type { SettingsPatch } from "@/lib/api/types";
import { cn } from "@/lib/text/format";
import { useSettings } from "@/store/settings";
import { UpdateStatus } from "./UpdateSettings";
import { useUpdates } from "@/store/updates";
import { useDialogs } from "@/store/dialogs";
import { useNavigation, type SettingsSection } from "@/store/navigation";
import {
  SECTION_LABELS,
  SETTINGS_CATALOG,
  SETTINGS_SECTIONS,
  SETTINGS_GROUPS,
  type SettingDefinition,
} from "./catalog";
import { COLOR_REGIONS } from "@/lib/prefs/colors";
import { useResolvedTheme } from "@/lib/prefs/useResolvedTheme";
import { PluginSettingsSection } from "@/features/plugins/PluginSettingsSection";
import { PluginConfigurationSection } from "@/features/plugins/configuration/components/PluginConfigurationSection";
import { matchingConfigurationFields } from "@/features/plugins/configuration/data/search";
import { usePlugins } from "@/store/plugins";
import { UiProviderSettings } from "@/features/plugins/UiProviderSettings";
import { KeyboardShortcuts } from "./KeyboardShortcuts";
import { SettingsProfiles } from "./SettingsProfiles";
import { NetworkSettingsSection } from "./NetworkSettings";
import { LogViewer } from "./LogViewer";
import { StorageSettings } from "./StorageSettings";
import { useViewState } from "@/lib/session/viewState";
import { sameSettings as samePreference } from "@/lib/prefs/profiles";

import { PreferenceSurface } from "./components/PreferenceSurface";
import { PreferenceFields } from "./components/PreferenceFields";
import { preferenceMetadata, protectedPreference } from "./data/preferenceMetadata";

export function SettingsPage({ visible: visiblePage = true }: { visible?: boolean }) {
  const { t, i18n } = useTranslation();
  const plugins = usePlugins((state) => state.items);
  const settings = useSettings((state) => state.settings);
  const theme = useResolvedTheme(settings.theme);
  const info = useSettings((state) => state.info);
  const error = useSettings((state) => state.error);
  const saving = useSettings((state) => state.saving);
  const updatesBusy = useUpdates(
    (state) => state.busy || state.state?.phase === "downloading" || state.state?.phase === "ready",
  );
  const update = useSettings((state) => state.update);
  const reset = useSettings((state) => state.reset);
  const confirm = useDialogs((state) => state.confirm);
  const section = useNavigation((state) => state.settingsSection);
  const settingsRequest = useNavigation((state) => state.settingsRequest);
  const selectSection = useNavigation((state) => state.selectSettings);
  const [query, setQuery] = useViewState("settings:query", "");
  const [modifiedOnly, setModifiedOnly] = useViewState("settings:modified", false);
  useLayoutEffect(() => {
    // Explicit navigation must reveal its destination, including repeat requests
    // for the current category. Merely switching tabs preserves the search.
    if (settingsRequest > 0) {
      setQuery("");
      setModifiedOnly(false);
    }
  }, [settingsRequest, setQuery, setModifiedOnly]);
  const shortcutRequest = useShortcutConflicts((state) => state.request);
  useLayoutEffect(() => {
    if (shortcutRequest > 0) {
      setQuery("");
      setModifiedOnly(false);
    }
  }, [shortcutRequest, setQuery, setModifiedOnly]);
  const [cssDraft, setCssDraft] = useViewState<string | null>("settings:css", null);
  const [resetVersions, setResetVersions] = useState<Record<string, number>>({});
  const body = useRef<HTMLDivElement>(null);
  const settingsId = useId();
  useLayoutEffect(() => {
    if (body.current) body.current.scrollTop = 0;
  }, [section, query, modifiedOnly, settingsRequest]);
  const clearNumberDrafts = (keys: readonly string[]) =>
    setResetVersions((previous) => {
      const next = { ...previous };
      for (const key of keys) next[key] = (next[key] ?? 0) + 1;
      return next;
    });
  const defaults = info?.defaultSettings ?? createDefaultSettings(info?.os);
  const filtering = Boolean(query.trim()) || modifiedOnly;
  const definitions = SETTINGS_CATALOG.filter(
    (item) => !(item.hideOnMac && info?.os === "macos") && (!item.macOnly || info?.os === "macos"),
  );
  const isModified = (item: SettingDefinition) =>
    !samePreference(settings[item.key], defaults[item.key]) ||
    (item.key === "userCss" && cssDraft !== null && cssDraft !== settings.userCss);
  const search = parseSearchQuery(query, ["is", "section", "id", "plugin", "group"]);
  const configurationCount = modifiedOnly
    ? 0
    : plugins.reduce(
        (count, plugin) => count + matchingConfigurationFields(plugin, query).length,
        0,
      );
  const modifiedRequested =
    modifiedOnly ||
    search.filters.some(
      (term) => !term.exclude && term.key === "is" && term.values.includes("modified"),
    );
  const storageText = [
    "storage",
    "migration",
    ...["en-US", "zh-CN"].flatMap((language) => {
      const translate = i18n.getFixedT(language);
      return [
        translate("storage.title"),
        translate("storage.description"),
        translate("storage.searchTerms"),
      ];
    }),
  ]
    .join(" ")
    .toLocaleLowerCase();
  const showStorage =
    !modifiedRequested &&
    (!filtering
      ? section === "advanced"
      : matchesSearch(search, storageText, { section: "advanced", id: "storage", is: [] }));
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
    return matchesSearch(search, text, {
      section: item.section,
      id: item.key,
      is: isModified(item) ? ["modified"] : [],
    });
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
  return (
    <div className="page settings">
      <SettingsProfiles
        hasDraft={cssDraft !== null && cssDraft !== settings.userCss}
        onApplied={() => {
          setCssDraft(null);
          clearNumberDrafts(definitions.map((definition) => definition.key));
        }}
      />
      <div className="settings-toolbar">
        <SearchField
          className="settings-search"
          aria-label={t("settings.search")}
          placeholder={t("settings.search")}
          value={query}
          onChange={setQuery}
          presets={[
            { key: "@is", value: "modified", label: t("searchUi.modified") },
            ...SETTINGS_SECTIONS.map((section) => ({
              key: "section",
              value: section,
              label: t(SECTION_LABELS[section]),
              exclusive: true,
            })),
            { key: "id", value: "", label: t("searchUi.id") },
            ...plugins
              .filter((plugin) => plugin.configuration)
              .map((plugin) => ({ key: "plugin", value: plugin.id, label: plugin.name })),
            { key: "group", value: "", label: t("configuration.groupFilter") },
          ]}
        />
        <label className="settings-modified-filter">
          <input
            type="checkbox"
            checked={modifiedRequested}
            onChange={(event) => {
              setModifiedOnly(event.target.checked);
              if (
                !event.target.checked &&
                search.filters.some(
                  (term) => !term.exclude && term.key === "is" && term.values.includes("modified"),
                )
              )
                setQuery(toggleSearchFilter(query, "@is", "modified", true));
            }}
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
              <span>
                {t("settings.resultCount", {
                  count: visible.length + Number(showStorage) + configurationCount,
                })}
              </span>
              <Button size="sm" variant="ghost" onClick={clearFilters}>
                {t("settings.clearFilters")}
              </Button>
            </div>
          ) : null}
          {SETTINGS_SECTIONS.filter(
            (item) =>
              visible.some((definition) => definition.section === item) ||
              (item === "advanced" && showStorage) ||
              (!filtering && item === section),
          ).map((item) => (
            <section className="settings-section" key={item} aria-label={t(SECTION_LABELS[item])}>
              <div className="settings-section__head">
                <h2 className="settings-section__title">{t(SECTION_LABELS[item])}</h2>
                {item !== "plugins" && item !== "shortcuts" && item !== "about" ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={
                      (item === "updates" && updatesBusy) ||
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
                {item === "files" && !filtering ? (
                  <p className="settings-section__intro">{t("settings.filePaneDefaultsHint")}</p>
                ) : null}
                {item === "plugins" && !filtering ? <PluginSettingsSection /> : null}
                {item === "about" && !filtering ? <AboutPage embedded /> : null}
                {item === "updates" && !filtering ? <UpdateStatus /> : null}
                {visible
                  .filter(
                    (definition) => definition.section === item && protectedPreference(definition),
                  )
                  .map((definition) =>
                    definition.kind === "uiProviders" ? (
                      <UiProviderSettings key={definition.key} />
                    ) : definition.kind === "network" ? (
                      <NetworkSettingsSection key={definition.key} />
                    ) : definition.kind === "shortcuts" ||
                      (definition.kind === "shortcutRules" &&
                        filtering &&
                        visible.find(
                          (candidate) =>
                            candidate.section === item && candidate.kind === "shortcutRules",
                        ) === definition &&
                        !visible.some(
                          (candidate) =>
                            candidate.section === item && candidate.kind === "shortcuts",
                        )) ? (
                      <div key={definition.key} data-setting="keyboardShortcuts">
                        <KeyboardShortcuts />
                      </div>
                    ) : null,
                  )}
                {visible.some(
                  (definition) => definition.section === item && !protectedPreference(definition),
                ) ? (
                  <PreferenceSurface
                    section={item}
                    query={query}
                    modifiedOnly={modifiedRequested}
                    visible={visiblePage}
                    fields={preferenceMetadata(
                      visible.filter((definition) => definition.section === item),
                      t,
                      isModified,
                    )}
                  >
                    <PreferenceFields
                      section={item}
                      definitions={visible.filter(
                        (definition) =>
                          definition.section === item && !protectedPreference(definition),
                      )}
                      settings={settings}
                      defaults={defaults}
                      filtering={filtering}
                      settingsId={settingsId}
                      resetVersions={resetVersions}
                      theme={theme}
                      cssDraft={cssDraft}
                      setCssDraft={setCssDraft}
                      onReset={resetOne}
                      isModified={isModified}
                    />
                  </PreferenceSurface>
                ) : null}
                {item === "advanced" && showStorage ? (
                  <div
                    id={`${settingsId}-storage`}
                    className="settings-preference-group"
                    data-settings-group="storage"
                  >
                    <h3 className="settings-preference-group__title">{t("storage.title")}</h3>
                    <div className="settings-preference-group__body">
                      <StorageSettings />
                    </div>
                  </div>
                ) : null}
                {!filtering && item === "advanced" ? (
                  <>
                    <LogViewer />
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
          <PluginConfigurationSection
            query={query}
            hidden={
              !((!filtering && section === "plugins") || (filtering && configurationCount > 0))
            }
            visible={
              visiblePage &&
              ((!filtering && section === "plugins") || (filtering && configurationCount > 0))
            }
          />
          {filtering && visible.length === 0 && !showStorage && !configurationCount ? (
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
