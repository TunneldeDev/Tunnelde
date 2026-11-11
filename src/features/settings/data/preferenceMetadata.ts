import type { TFunction } from "i18next";
import type { SettingDefinition } from "../catalog";
import type { FrontendPreferenceField } from "@/lib/extensions/contracts/preferences/provider";
import { preferencePaths } from "@/lib/preferences/mapping";

/** Host-owned trust, credentials and conflict resolution never move into Fields. */
export function protectedPreference(definition: SettingDefinition): boolean {
  return ["uiProviders", "network", "shortcuts", "shortcutRules"].includes(definition.kind);
}

export function preferenceMetadata(
  definitions: readonly SettingDefinition[],
  translate: TFunction,
  modified: (definition: SettingDefinition) => boolean,
): FrontendPreferenceField[] {
  return definitions
    .filter((definition) => !protectedPreference(definition))
    .flatMap((definition) => {
      const id = preferencePaths[definition.key as keyof typeof preferencePaths];
      return id
        ? [
            {
              id,
              label: translate(definition.label),
              description: definition.hint ? translate(definition.hint) : "",
              modified: modified(definition),
            },
          ]
        : [];
    });
}
