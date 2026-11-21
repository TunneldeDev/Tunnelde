import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/form/Button";
import { Dialog } from "@/components/ui/overlay/Dialog";
import { usePluginSecurity } from "@/store/pluginSecurity";
import { PluginError } from "./PluginError";
import { useNodeRuntimeGateOpen } from "./NodeRuntimeSection";
import { useDialogs } from "@/store/dialogs";
import { useNavigation } from "@/store/navigation";

export { PluginPermissionList } from "./components/PluginPermissionList";
import { PluginPermissionList } from "./components/PluginPermissionList";

export function PluginPermissionGate() {
  const { t } = useTranslation();
  const { prompts, busy, error, approve, deny, setRestricted } = usePluginSecurity();
  const nodeOpen = useNodeRuntimeGateOpen();
  const dialogOpen = useDialogs((value) => value.dialog.kind !== "none");
  const plugin = prompts[0];
  if (!plugin || nodeOpen || dialogOpen) return null;
  return (
    <Dialog
      open
      title={t("pluginSecurity.allowTitle", { name: plugin.name })}
      closeLabel={t("common.close")}
      onClose={() => deny(plugin.id)}
      dismissible={!busy}
      width={600}
      footer={
        <>
          <Button disabled={busy} onClick={() => void setRestricted(true)}>
            {t("pluginSecurity.enterRestricted")}
          </Button>
          <Button disabled={busy} onClick={() => deny(plugin.id)}>
            {t("pluginSecurity.deny")}
          </Button>
          <Button variant="primary" disabled={busy} onClick={() => void approve(plugin.id)}>
            {t("pluginSecurity.allow")}
          </Button>
        </>
      }
    >
      <p>{t("pluginSecurity.allowBody", { name: plugin.name, version: plugin.version })}</p>
      <p className="settings-hint">
        {t("pluginSecurity.publisher", {
          name: plugin.author?.trim() || t("market.unknownAuthor"),
        })}
        <br />
        {plugin.sourceUrl ?? plugin.path}
      </p>
      <PluginPermissionList permissions={plugin.permissions} />
      {plugin.frontend && (
        <p role="note" className="panel__error">
          {t("pluginSecurity.trustedUiWarning")}
        </p>
      )}
      {!["declarative", "frontend"].includes(plugin.runtime ?? "node") && (
        <p className="settings-hint">
          {t(
            plugin.runtime === "wasm" ? "pluginSecurity.wasmWarning" : "pluginSecurity.nodeWarning",
          )}
        </p>
      )}
      <p className="settings-hint">{t("pluginSecurity.updateWarning")}</p>
      {error ? <PluginError message={error} /> : null}
    </Dialog>
  );
}

export function PluginRecoveryPrompt() {
  const { t } = useTranslation();
  const { recoveryPrompt, prompts, state, failure, busy, error, setRestricted, dismissRecovery } =
    usePluginSecurity();
  const nodeOpen = useNodeRuntimeGateOpen();
  const dialogOpen = useDialogs((value) => value.dialog.kind !== "none");
  if (!recoveryPrompt || prompts.length || nodeOpen || dialogOpen) return null;
  const protectedStartup = recoveryPrompt === "startup" && state.restricted;
  return (
    <Dialog
      open
      title={t("pluginSecurity.recoveryTitle")}
      closeLabel={t("common.close")}
      onClose={dismissRecovery}
      dismissible={!busy}
      width={560}
      footer={
        <>
          <Button disabled={busy} onClick={dismissRecovery}>
            {t(protectedStartup ? "pluginSecurity.keepRestricted" : "pluginSecurity.notNow")}
          </Button>
          {protectedStartup ? (
            <Button
              variant="primary"
              disabled={busy}
              onClick={() => {
                dismissRecovery();
                useNavigation.getState().showSidebar("plugins");
              }}
            >
              {t("pluginSecurity.viewPlugins")}
            </Button>
          ) : (
            <Button
              variant="primary"
              disabled={busy}
              onClick={() => {
                void setRestricted(true).then((ok) => {
                  if (ok) dismissRecovery();
                });
              }}
            >
              {t("pluginSecurity.enterRestricted")}
            </Button>
          )}
        </>
      }
    >
      <p>
        {t(
          protectedStartup
            ? "pluginSecurity.protectedStartup"
            : recoveryPrompt === "startup"
              ? "pluginSecurity.recoveryHint"
              : "pluginSecurity.failureHint",
        )}
      </p>
      {failure ? <p className="settings-hint">{failure}</p> : null}
      {error ? <PluginError message={error} /> : null}
    </Dialog>
  );
}
