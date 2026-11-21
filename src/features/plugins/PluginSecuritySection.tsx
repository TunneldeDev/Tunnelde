import { copyText } from "@/lib/session/clipboard";
import {
  PluginSecuritySectionView,
  type PluginSecurityServices,
} from "./components/PluginSecuritySectionView";
import { useViewState, useBackgroundGuard } from "@/lib/session/viewState";
import { ShieldAlert } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/form/Button";
import { usePluginSecurity } from "@/store/pluginSecurity";
import { usePlugins } from "@/store/plugins";
import { useNavigation } from "@/store/navigation";
import { useWorkspace } from "@/store/workspace";

function openSecurity() {
  useNavigation.getState().selectSettings("plugins");
  useWorkspace.getState().openPage("settings");
}

export function PluginSecurityBadge() {
  const { t } = useTranslation();
  const { state, failure, recoveryDismissed } = usePluginSecurity();
  if (!state.restricted && !failure && (!state.recoverySuggested || recoveryDismissed)) return null;
  return (
    <button
      type="button"
      className="statusbar__link plugin-security-badge"
      onClick={openSecurity}
      title={t("pluginSecurity.title")}
    >
      <ShieldAlert size={12} />
      {t(state.restricted ? "pluginSecurity.restricted" : "pluginSecurity.review")}
    </button>
  );
}

export function PluginRestrictedAction() {
  const { t } = useTranslation();
  const { state, busy, setRestricted } = usePluginSecurity();
  return state.restricted ? null : (
    <Button size="sm" disabled={busy} onClick={() => void setRestricted(true)}>
      {t("pluginSecurity.enterRestricted")}
    </Button>
  );
}

const services: PluginSecurityServices = {
  useData() {
    const { state, ready, loading, busy, error, failure, recoveryDismissed } = usePluginSecurity();
    const plugins = usePlugins((s) => s.items);
    return { state, ready, loading, busy, error, failure, recoveryDismissed, plugins };
  },
  useViewState,
  useBusyGuard: useBackgroundGuard,
  load: (force) => usePluginSecurity.getState().load(force),
  setRestricted: (enabled) => usePluginSecurity.getState().setRestricted(enabled),
  revoke: (id) => usePluginSecurity.getState().revoke(id),
  copyError: copyText,
  dismissRecovery: () => usePluginSecurity.getState().dismissRecovery(),
};
export function PluginSecuritySection() {
  return <PluginSecuritySectionView services={services} />;
}
