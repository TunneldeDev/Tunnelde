import { useTranslation } from "react-i18next";
import { Plus } from "lucide-react";
import { ForwardingSection } from "./ForwardingSection";
import { ForwardingPanelView } from "./components/ForwardingPanelView";
import { useForwardingSnapshot } from "./data/store";
import { useHosts } from "@/store/hosts";
import { useForwardingSessions } from "./data/readScope";
import { presentError } from "@/lib/api/errors";
import { useNavigation } from "@/store/navigation";
import { useDialogs } from "@/store/dialogs";
import { Button } from "@/components/ui/form/Button";

/** Main-document owner. Native renderers use ForwardingPanelView directly and
 * must supply their own host creation route and selected provider services. */
export function ForwardingPanel() {
  const { t } = useTranslation();
  const hosts = useHosts((state) => state.hosts);
  const hostsLoading = useHosts((state) => state.loading && !state.loaded);
  const openHost = useDialogs((state) => state.openHost);
  const sessions = useForwardingSessions();
  const target = useNavigation((state) => state.forwardingTarget);
  const snapshot = useForwardingSnapshot();
  return (
    <ForwardingPanelView
      hosts={hosts}
      hostsLoading={hostsLoading}
      sessions={sessions}
      rules={snapshot.entries ?? []}
      error={snapshot.error ? presentError(snapshot.error) : null}
      target={target}
      renderHost={(host) => <ForwardingSection key={host.id} host={host} embedded />}
      emptyAction={
        <Button
          variant="secondary"
          size="sm"
          leading={<Plus size={13} />}
          onClick={() => openHost()}
        >
          {t("sidebar.newHost")}
        </Button>
      }
    />
  );
}
