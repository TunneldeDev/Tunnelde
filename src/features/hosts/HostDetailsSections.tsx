import { usePlugins } from "@/store/plugins";
import { useSettings } from "@/store/settings";
import { hasPluginGrant, usePluginSecurity } from "@/store/pluginSecurity";
import { isTauri } from "@/lib/api/ipc";
import { selectedHostDetails } from "@/lib/extensions/hostDetails";
import { PluginComponentView } from "@/features/plugins/PluginComponentView";

/** Only the selected mount contributor renders; other detail sections compose. */
export function HostDetailsSections({ hostId }: { hostId: string }) {
  const plugins = usePlugins((state) => state.items);
  const selection = useSettings((state) => state.settings.mountHostDetailsSelection);
  const security = usePluginSecurity((state) => state.state);
  if (security.restricted) return null;
  return selectedHostDetails(plugins, selection)
    .filter(
      ({ plugin }) =>
        plugin.status === "running" && (!isTauri() || hasPluginGrant(security, plugin)),
    )
    .map(({ plugin, contribution }) => (
      <section
        className="card"
        key={`${hostId}:${plugin.id}:${contribution.id}:${plugin.fingerprint ?? ""}`}
        aria-label={contribution.title}
      >
        <h2 className="card__title">{contribution.title}</h2>
        <PluginComponentView
          pluginId={plugin.id}
          viewId={contribution.viewId}
          hostDetails={Object.freeze({
            hostId,
            contributionId: contribution.id,
            kind: contribution.kind,
          })}
        />
      </section>
    ));
}
