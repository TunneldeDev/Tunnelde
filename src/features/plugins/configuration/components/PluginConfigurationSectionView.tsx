import type { ConfigurationPlugin, ConfigurationServices } from "../data/services";
import { useTranslation } from "react-i18next";
import { SearchField } from "@/components/ui/form/SearchField";
import { ConfigurationFormView } from "./ConfigurationFormView";
import { configurationFilterKeys, matchingConfigurationFields } from "../data/search";
import "./configuration.css";

function PluginGroup({
  plugin,
  query,
  visible,
  services,
}: {
  plugin: ConfigurationPlugin;
  services: ConfigurationServices;
  query: string;
  visible: boolean;
}) {
  const { useViewState } = services;
  const key = `configuration:${plugin.id}:${plugin.fingerprint ?? ""}`;
  const [opened, setOpened] = useViewState(`${key}:opened`, false);
  const [expanded, setExpanded] = useViewState(`${key}:expanded`, false);
  const matches = matchingConfigurationFields(plugin, query).length;
  return (
    <details
      className="plugin-configuration__plugin"
      hidden={!matches}
      open={expanded}
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
        <ConfigurationFormView
          services={services}
          plugin={plugin}
          query={query}
          visible={visible && expanded && matches > 0}
        />
      ) : null}
    </details>
  );
}
export function PluginConfigurationSectionView({
  query: outerQuery = "",
  visible = true,
  hidden = false,
  plugins,
  services,
}: {
  plugins: ConfigurationPlugin[];
  services: ConfigurationServices;
  query?: string;
  visible?: boolean;
  hidden?: boolean;
}) {
  const { t } = useTranslation();
  const { useViewState } = services;
  const [localQuery, setLocalQuery] = useViewState("configuration:query", "");
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
          services={services}
        />
      ))}
      {!plugins.some((plugin) => matchingConfigurationFields(plugin, query).length) ? (
        <p>{t("common.noResults")}</p>
      ) : null}
    </section>
  );
}
