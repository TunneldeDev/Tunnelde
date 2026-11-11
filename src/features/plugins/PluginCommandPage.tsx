import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/form/Button";
import { usePlugins } from "@/store/plugins";
import { openPluginAction } from "@/lib/plugins/actions";
import { PluginCommandResult } from "./PluginCommandResult";
import { PluginRestrictedAction } from "./PluginSecuritySection";

export function PluginCommandPage({ pluginId }: { pluginId: string }) {
  const { t } = useTranslation();
  const plugin = usePlugins((state) => state.items.find((item) => item.id === pluginId));
  const result = usePlugins((state) => state.outputs[pluginId]);
  const busy = usePlugins((state) => state.busyIds.includes(pluginId));
  return (
    <div className="page plugin-command-page" aria-busy={busy}>
      <header>
        <h1>{plugin?.name ?? pluginId}</h1>
        <p className="settings-hint">{plugin?.description}</p>
      </header>
      <div className="plugin-tool__actions">
        {plugin?.commands.map((command) => (
          <Button
            key={command.id}
            disabled={busy}
            onClick={() =>
              void (command.hostMenu
                ? openPluginAction({ id: pluginId, command: command.id })
                : usePlugins.getState().run(pluginId, command.id))
            }
          >
            {command.title}
          </Button>
        ))}
      </div>
      {busy && <p role="status">{t("pluginView.running")}</p>}
      {result && (
        <PluginCommandResult
          result={result}
          onClear={() => usePlugins.getState().clearOutput(pluginId)}
        />
      )}
      {result?.error && <PluginRestrictedAction />}
    </div>
  );
}
