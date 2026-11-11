import { matchesSearch, parseSearchQuery } from "@/lib/search/query";
import type { PluginInfo } from "@/lib/api/types";
import type { ConfigurationField } from "@/lib/extensions/contracts/configuration/schema";

export const configurationFilterKeys = ["plugin", "group", "id", "section", "is"];
export function matchingConfigurationFields(
  plugin: PluginInfo,
  query: string,
): ConfigurationField[] {
  const search = parseSearchQuery(query, configurationFilterKeys);
  return (
    plugin.configuration?.fields.filter((field) => {
      const group = plugin.configuration?.groups.find((group) => group.id === field.group);
      return matchesSearch(
        search,
        [plugin.id, plugin.name, field.id, field.title, field.description, group?.title].join(" "),
        {
          plugin: [plugin.id, plugin.name],
          group: [field.group, group?.title],
          id: field.id,
          section: "plugins",
          is: [],
        },
      );
    }) ?? []
  );
}
