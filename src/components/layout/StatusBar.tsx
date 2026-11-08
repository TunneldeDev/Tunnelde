import { useEffect, type ReactNode } from "react";
import { RefreshCw, PanelRightClose, PanelRightOpen } from "lucide-react";
import { useTranslation } from "react-i18next";

import { IconButton } from "@/components/ui/form/Button";
import { StatusDot } from "@/components/ui/display/Misc";
import { UpdatePill } from "@/components/layout/UpdatePill";
import { PluginSecurityBadge } from "@/features/plugins/PluginSecuritySection";
import { useHosts } from "@/store/hosts";
import { useSettings } from "@/store/settings";
import { useWorkspace } from "@/store/workspace";
import { requestApplicationAction } from "@/lib/session/restart";
import { useStorage } from "@/store/storage";
import { PluginStatusItem } from "./PluginStatusItem";
import { useStatusBarContributions, wireStatusBarContributions } from "@/store/statusBar";
import { orderStatusItems } from "@/lib/plugins/statusBar";
import { isTauri } from "@/lib/api/ipc";
import { BackgroundTaskStatusButton } from "@/features/tasks/BackgroundTasks";
import { OutputStatusButton } from "@/features/output/OutputStatusButton";

interface StatusBarProps {
  panelOpen: boolean;
  onTogglePanel: () => void;
}

export function StatusBar({ panelOpen, onTogglePanel }: StatusBarProps) {
  const { t } = useTranslation();
  const pendingRestart = useStorage((state) => state.restartPending);
  const info = useSettings((state) => state.info);
  const hostCount = useHosts((state) => state.hosts.length);
  const openPage = useWorkspace((state) => state.openPage);

  const contributions = useStatusBarContributions((state) => state.items);
  useEffect(() => {
    if (!isTauri()) return;
    const controller = new AbortController();
    void wireStatusBarContributions(controller.signal).catch((error: unknown) =>
      console.error("Status bar subscription failed", error),
    );
    return () => controller.abort();
  }, []);
  const pluginItems = (alignment: "left" | "right") =>
    contributions
      .filter((item) => item.alignment === alignment)
      .map((item) => ({
        id: `plugin:${item.pluginId}:${item.id}`,
        priority: item.priority,
        content: <PluginStatusItem item={item} />,
      }));
  const leftItems: StatusItem[] = [
    {
      id: "core.ready",
      priority: 10000,
      content: (
        <>
          <StatusDot tone="ok" />
          <span>{t("status.ready")}</span>
        </>
      ),
    },
    {
      id: "core.hosts",
      priority: 9000,
      content: (
        <>
          <span className="statusbar__sep" />
          <span className="statusbar__muted">{t("status.hosts", { count: hostCount })}</span>
        </>
      ),
    },
    ...pluginItems("left"),
  ];
  const rightItems: StatusItem[] = [
    ...pluginItems("right"),
    {
      id: "core.controls",
      priority: -10000,
      content: (
        <>
          {pendingRestart ? (
            <button
              type="button"
              className="statusbar__link restart-indicator"
              onClick={() => requestApplicationAction("restart")}
            >
              <RefreshCw size={13} /> {t("restart.now")}
            </button>
          ) : null}
          <BackgroundTaskStatusButton />
          <OutputStatusButton />
          <UpdatePill />
          <PluginSecurityBadge />
          <IconButton
            size="sm"
            active={panelOpen}
            label={panelOpen ? t("panel.hide") : t("panel.show")}
            onClick={onTogglePanel}
          >
            {panelOpen ? <PanelRightClose size={13} /> : <PanelRightOpen size={13} />}
          </IconButton>
          <button
            type="button"
            className="statusbar__link"
            onClick={() => openPage("updates")}
            aria-label={t("settings.updatesSection")}
          >
            {t("status.version", { version: info?.version ?? "0.1.0" })}
          </button>
        </>
      ),
    },
  ];
  return (
    <footer className="statusbar">
      <StatusGroup items={leftItems} alignment="left" />
      <StatusGroup items={rightItems} alignment="right" />
    </footer>
  );
}

interface StatusItem {
  id: string;
  priority: number;
  content: ReactNode;
}
function StatusGroup({ items, alignment }: { items: StatusItem[]; alignment: "left" | "right" }) {
  return (
    <div className={`statusbar__group statusbar__group--${alignment}`}>
      {orderStatusItems(items).map((item) => (
        <div
          key={item.id}
          className={
            item.id.startsWith("plugin:")
              ? "statusbar__slot statusbar__slot--plugin"
              : "statusbar__slot"
          }
        >
          {item.content}
        </div>
      ))}
    </div>
  );
}
