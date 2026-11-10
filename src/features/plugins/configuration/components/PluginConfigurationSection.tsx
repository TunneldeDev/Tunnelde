import { useState } from "react";
import { useTranslation } from "react-i18next";
import { SearchField } from "@/components/ui/form/SearchField";
import { usePlugins } from "@/store/plugins";
import type { PluginInfo } from "@/lib/api/types";
import { ConfigurationForm } from "./ConfigurationForm";
import { configurationFilterKeys, matchingConfigurationFields } from "../data/search";
import "./configuration.css";

function PluginGroup({
  plugin,
  query,
  visible,
}: {
  plugin: PluginInfo;
  query: string;
  visible: boolean;
}) {
  const [opened, setOpened] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const matches = matchingConfigurationFields(plugin, query).length;
  return (
    <details
      className="plugin-configuration__plugin"
      hidden={!matches}
      onToggle={(event) => {
        setExpanded(event.currentTarget.open);
        if (event.currentTarget.open) setOpened(true);
      }}
    >
      <summary>
        <span>
          <strong>{plugin.name}</strong>
          <code>{plugin.id}</code>
        </span>
        <small>
          {matches} / {plugin.configuration?.fields.length}
        </small>
      </summary>
      {opened ? (
        <ConfigurationForm
          plugin={plugin}
          query={query}
          visible={visible && expanded && matches > 0}
        />
      ) : null}
    </details>
  );
}
export function PluginConfigurationSection({
  query: outerQuery = "",
  visible = true,
  hidden = false,
}: {
  query?: string;
  visible?: boolean;
  hidden?: boolean;
}) {
  const { t } = useTranslation();
  const plugins = usePlugins((state) => state.items).filter((plugin) => plugin.configuration);
  const [localQuery, setLocalQuery] = useState("");
  const query = outerQuery || localQuery;
  if (!plugins.length) return null;
  return (
    <section
      className="settings-subsection plugin-configuration"
      hidden={hidden}
      aria-label={t("configuration.title")}
    >
      <h3 className="settings-subtitle">{t("configuration.title")}</h3>
      <p className="settings-hint">{t("configuration.hint")}</p>
      {!outerQuery ? (
        <SearchField
          value={localQuery}
          onChange={setLocalQuery}
          aria-label={t("configuration.search")}
          placeholder={t("configuration.searchPlaceholder")}
          filterKeys={configurationFilterKeys}
          presets={[
            ...plugins.map((plugin) => ({ key: "plugin", value: plugin.id, label: plugin.name })),
            { key: "group", value: "", label: t("configuration.groupFilter") },
            { key: "id", value: "", label: t("configuration.fieldFilter") },
          ]}
        />
      ) : null}
      {plugins.map((plugin) => (
        <PluginGroup
          key={`${plugin.id}:${plugin.fingerprint}`}
          plugin={plugin}
          query={query}
          visible={visible}
        />
      ))}
      {!plugins.some((plugin) => matchingConfigurationFields(plugin, query).length) ? (
        <p>{t("common.noResults")}</p>
      ) : null}
    </section>
  );
}
