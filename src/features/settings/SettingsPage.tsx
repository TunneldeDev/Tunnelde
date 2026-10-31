// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

import { FileCode2, FolderOpen, RotateCcw } from "lucide-react";
import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/form/Button";
import { Switch, Textarea } from "@/components/ui/form/Field";
import { Select } from "@/components/ui/form/Select";
import { Segmented, Stepper, SwatchPicker } from "@/components/ui/form/Segmented";
import { PluginsSection } from "@/features/plugins/PluginsSection";
import { KnownHostsList } from "@/features/settings/KnownHostsList";
import { validateUserCss } from "@/lib/prefs/appearance";
import { MONO_FONT_OPTIONS } from "@/lib/prefs/defaults";
import { translateError } from "@/lib/api/errors";
import { api, isTauri } from "@/lib/api/ipc";
import { formatDateTime } from "@/lib/text/format";
import type { Density, Language, MonoFont, ThemeMode } from "@/lib/api/types";
import { toast } from "@/store/toasts";
import { useSettings } from "@/store/settings";
import { useUpdates } from "@/store/updates";
import { useWorkspace } from "@/store/workspace";
import { useDialogs } from "@/store/dialogs";

type Section = "general" | "appearance" | "files" | "plugins" | "hosts" | "css" | "updates" | "advanced";

const SECTIONS: Section[] = [
  "general",
  "appearance",
  "files",
  "plugins",
  "hosts",
  "css",
  "updates",
  "advanced",
];

const SECTION_KEYS = {
  general: "settings.general",
  appearance: "settings.appearance",
  files: "settings.files",
  plugins: "settings.plugins",
  hosts: "settings.knownHosts",
  css: "settings.css",
  updates: "settings.updatesSection",
  advanced: "settings.advanced",
} as const;

function Row({ label, control, hint }: { label: string; control: ReactNode; hint?: string }) {
  return (
    <div className="settings-row">
      <div className="settings-row__text">
        <span className="settings-row__label">{label}</span>
        {hint ? <span className="settings-row__hint">{hint}</span> : null}
      </div>
      <div className="settings-row__control">{control}</div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="settings-section">
      <h2 className="settings-section__title">{title}</h2>
      <div className="settings-section__body">{children}</div>
    </section>
  );
}

function GeneralSection() {
  const { t } = useTranslation();
  const settings = useSettings((state) => state.settings);
  const info = useSettings((state) => state.info);
  const update = useSettings((state) => state.update);

  return (
    <Section title={t("settings.general")}>
      <Row
        label={t("settings.language")}
        control={
          <Select
            label={t("settings.language")}
            value={settings.language}
            options={[
              { value: "system", label: t("settings.languageSystem") },
              { value: "zh-CN", label: "简体中文" },
              { value: "en-US", label: "English" },
            ]}
            onChange={(value) => void update({ language: value as Language })}
          />
        }
      />
      <Row
        label={t("settings.nativeMenu")}
        control={
          <Switch
            label={t("settings.nativeMenu")}
            checked={settings.nativeMenu}
            onChange={(nativeMenu) => void update({ nativeMenu })}
          />
        }
      />
      <Row
        label={t("settings.version")}
        control={<span className="settings-value">{info?.version ?? "0.1.0"}</span>}
      />
    </Section>
  );
}

function FilesSection() {
  const { t } = useTranslation();
  const settings = useSettings((state) => state.settings);
  const update = useSettings((state) => state.update);

  return (
    <Section title={t("settings.files")}>
      <Row
        label={t("settings.preloadDirs")}
        control={
          <Switch
            label={t("settings.preloadDirs")}
            checked={settings.preloadDirs}
            onChange={(preloadDirs) => void update({ preloadDirs })}
          />
        }
      />
    </Section>
  );
}

function AppearanceSection() {
  const { t } = useTranslation();
  const settings = useSettings((state) => state.settings);
  const update = useSettings((state) => state.update);

  return (
    <Section title={t("settings.appearance")}>
      <Row
        label={t("settings.theme")}
        control={
          <Segmented
            label={t("settings.theme")}
            value={settings.theme}
            options={[
              { value: "dark", label: t("settings.themeDark") },
              { value: "light", label: t("settings.themeLight") },
              { value: "system", label: t("settings.themeSystem") },
            ]}
            onChange={(value: ThemeMode) => void update({ theme: value })}
          />
        }
      />
      <Row
        label={t("settings.accent")}
        control={
          <SwatchPicker value={settings.accent} onChange={(accent) => void update({ accent })} />
        }
      />
      <Row
        label={t("settings.density")}
        control={
          <Segmented
            label={t("settings.density")}
            value={settings.density}
            options={[
              { value: "comfortable", label: t("settings.densityComfortable") },
              { value: "compact", label: t("settings.densityCompact") },
            ]}
            onChange={(value: Density) => void update({ density: value })}
          />
        }
      />
      <Row
        label={t("settings.uiFontSize")}
        control={
          <Stepper
            label={t("settings.uiFontSize")}
            value={settings.uiFontSize}
            min={11}
            max={16}
            onChange={(uiFontSize) => void update({ uiFontSize })}
          />
        }
      />
      <Row
        label={t("settings.monoFontSize")}
        control={
          <Stepper
            label={t("settings.monoFontSize")}
            value={settings.monoFontSize}
            min={11}
            max={20}
            onChange={(monoFontSize) => void update({ monoFontSize })}
          />
        }
      />
      <Row
        label={t("settings.monoFont")}
        control={
          <Select
            label={t("settings.monoFont")}
            value={settings.monoFont}
            options={MONO_FONT_OPTIONS}
            onChange={(value) => void update({ monoFont: value as MonoFont })}
          />
        }
      />
    </Section>
  );
}

function CssSection() {
  const { t } = useTranslation();
  const settings = useSettings((state) => state.settings);
  const update = useSettings((state) => state.update);
  const [draftState, setDraftState] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const draft = draftState ?? settings.userCss;

  const apply = async () => {
    const check = validateUserCss(draft);
    if (!check.ok) {
      setMessage({ tone: "error", text: t("settings.cssRejected") });
      return;
    }
    await update({ userCss: draft });
    setDraftState(null);
    setMessage({ tone: "ok", text: t("settings.cssApplied") });
  };

  const importFile = async () => {
    if (!isTauri()) {
      return;
    }
    try {
      const text = await api.importCss();
      if (text !== null) {
        setDraftState(text);
        setMessage({ tone: "ok", text: t("toast.cssImported") });
      }
    } catch (error) {
      toast(translateError(error), "error");
    }
  };

  const exportFile = async () => {
    if (!isTauri()) {
      return;
    }
    try {
      const path = await api.exportCss(draft);
      if (path) {
        toast(t("toast.cssExported", { path }), "success");
      }
    } catch (error) {
      toast(translateError(error), "error");
    }
  };

  return (
    <Section title={t("settings.customCss")}>
      <Textarea
        className="settings-css"
        aria-label={t("settings.customCss")}
        spellCheck={false}
        rows={14}
        value={draft}
        placeholder={t("settings.customCssPlaceholder")}
        onChange={(event) => {
          setDraftState(event.target.value);
          setMessage(null);
        }}
      />
      {message ? (
        <p
          className={message.tone === "ok" ? "settings-message is-ok" : "settings-message is-error"}
        >
          {message.text}
        </p>
      ) : null}
      <div className="settings-actions">
        <Button variant="primary" onClick={() => void apply()}>
          {t("common.apply")}
        </Button>
        <Button
          variant="secondary"
          leading={<FileCode2 size={14} />}
          onClick={() => void importFile()}
        >
          {t("common.import")}
        </Button>
        <Button variant="ghost" onClick={() => void exportFile()}>
          {t("common.export")}
        </Button>
        <Button
          variant="ghost"
          onClick={() => {
            setDraftState(null);
            setMessage(null);
            void update({ userCss: "" });
          }}
        >
          {t("common.reset")}
        </Button>
      </div>
    </Section>
  );
}

function UpdatesSection() {
  const { t, i18n } = useTranslation();
  const settings = useSettings((state) => state.settings);
  const update = useSettings((state) => state.update);
  const info = useSettings((state) => state.info);
  const openPage = useWorkspace((state) => state.openPage);
  const locale = i18n.resolvedLanguage ?? "en-US";

  return (
    <Section title={t("settings.updatesSection")}>
      <Row
        label={t("settings.autoCheck")}
        control={
          <Switch
            label={t("settings.autoCheck")}
            checked={settings.autoCheckUpdates}
            onChange={(autoCheckUpdates) => void update({ autoCheckUpdates })}
          />
        }
      />
      <Row
        label={t("settings.version")}
        control={<span className="settings-value">{info?.version ?? "0.1.0"}</span>}
      />
      <Row
        label={t("updates.lastChecked")}
        control={
          <span className="settings-value">
            {settings.lastUpdateCheck
              ? formatDateTime(settings.lastUpdateCheck, locale)
              : t("common.never")}
          </span>
        }
      />
      <div className="settings-actions">
        <Button
          variant="secondary"
          onClick={() => {
            openPage("updates");
            void useUpdates.getState().check(true);
          }}
        >
          {t("updates.check")}
        </Button>
      </div>
    </Section>
  );
}

function AdvancedSection() {
  const { t } = useTranslation();
  const settings = useSettings((state) => state.settings);
  const info = useSettings((state) => state.info);
  const update = useSettings((state) => state.update);
  const reset = useSettings((state) => state.reset);
  const confirm = useDialogs((state) => state.confirm);
  const isMac = info?.os === "macos";

  return (
    <Section title={t("settings.advanced")}>
      <Row
        label={t("settings.dataDir")}
        control={
          <div className="settings-inline">
            <code className="settings-path">{info?.dataDir ?? "—"}</code>
            <Button
              variant="ghost"
              size="sm"
              leading={<FolderOpen size={13} />}
              onClick={() =>
                void api.openDataDir().catch((error) => toast(translateError(error), "error"))
              }
            >
              {t("settings.openData")}
            </Button>
          </div>
        }
      />
      <Row
        label={t("settings.logDir")}
        control={
          <div className="settings-inline">
            <code className="settings-path">{info?.logDir ?? "—"}</code>
            <Button
              variant="ghost"
              size="sm"
              leading={<FolderOpen size={13} />}
              onClick={() =>
                void api.openLogDir().catch((error) => toast(translateError(error), "error"))
              }
            >
              {t("settings.openLogs")}
            </Button>
          </div>
        }
      />
      {isMac ? null : (
        <Row
          label={t("settings.closeToTray")}
          control={
            <Switch
              label={t("settings.closeToTray")}
              checked={settings.closeToTray}
              onChange={(closeToTray) => void update({ closeToTray })}
            />
          }
        />
      )}
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
              onConfirm: () => void reset(),
            })
          }
        >
          {t("settings.resetAll")}
        </Button>
      </div>
    </Section>
  );
}

function TrustedHostsSection() {
  const { t } = useTranslation();

  return (
    <Section title={t("settings.knownHosts")}>
      <KnownHostsList />
    </Section>
  );
}

export function SettingsPage() {
  const { t } = useTranslation();
  const [section, setSection] = useState<Section>("general");

  return (
    <div className="page settings">
      <nav className="settings__nav" aria-label={t("settings.title")}>
        {SECTIONS.map((item) => (
          <button
            key={item}
            type="button"
            className={item === section ? "settings__nav-item is-active" : "settings__nav-item"}
            onClick={() => setSection(item)}
          >
            {t(SECTION_KEYS[item])}
          </button>
        ))}
      </nav>
      <div className="settings__body">
        {section === "general" ? <GeneralSection /> : null}
        {section === "appearance" ? <AppearanceSection /> : null}
        {section === "files" ? <FilesSection /> : null}
        {section === "plugins" ? <PluginsSection /> : null}
        {section === "hosts" ? <TrustedHostsSection /> : null}
        {section === "css" ? <CssSection /> : null}
        {section === "updates" ? <UpdatesSection /> : null}
        {section === "advanced" ? <AdvancedSection /> : null}
      </div>
    </div>
  );
}
