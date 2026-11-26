import type { HostSourcesSnapshot } from "@/lib/hosts/sources";
import { listen } from "@tauri-apps/api/event";
import { reportError } from "@/lib/diagnostics";
import type {
  PluginConfig,
  PluginDownload,
  PluginEvent,
  PluginInfo,
  PluginSecurityState,
  Settings,
  SshClosedPayload,
  SshDataPayload,
  TransferEvent,
  UpdateState,
} from "@/lib/api/types";
import { createEventBus } from "./bus";

import type { StatusBarSnapshot } from "@/lib/plugins/statusBar";
import type { TabBarSnapshot } from "@/lib/plugins/tabBar";
import type { HostDecorationSnapshot } from "@/lib/plugins/hostList";
import type { FileHighlightSnapshot } from "@/lib/plugins/fileHighlights";
import type { HostColumnsSnapshot } from "@/lib/hosts/columns";
import type { FrontendActivation } from "@/lib/plugins/activation/contracts";

export interface NativeEvents {
  "mounts://changed": null;
  "mounts://operation-changed": { id: string; revision: string };
  "plugin://activate-frontend": FrontendActivation;
  "plugin://configuration-changed": { pluginId: string; revision: string; schemaDigest: string };
  "plugin://host-columns-changed": HostColumnsSnapshot;
  "plugin://host-sources-changed": HostSourcesSnapshot;
  "hosts://fields-changed": { pluginId: string; hostId: string; revision: number };
  "plugin://host-list-changed": HostDecorationSnapshot;
  "plugin://file-highlights-changed": FileHighlightSnapshot;
  "plugin://tab-bar-changed": TabBarSnapshot;
  "plugin://status-bar-changed": StatusBarSnapshot;
  "plugin://event": PluginEvent;
  "plugin:security-changed": PluginSecurityState;
  "plugins://download": PluginDownload;
  "plugins://config": PluginConfig;
  "settings://changed": Settings;
  "settings-profiles://changed": null;
  "update://state": UpdateState;
  "ui://navigate": string;
  "ui://suspend": number;
  "ui://resume": null;
  "ssh://data": SshDataPayload;
  "ssh://closed": SshClosedPayload;
  "plugin://state": PluginInfo;
  "sftp://transfer": TransferEvent;
  "sftp://changed": null;
  "editor://cleanup-changed": null;
  "plugin://domain-changed": { domain: string; sessionId?: string | null; hostId?: string | null };
  "plugin://workspace-request": {
    requestId: string;
    pluginId: string;
    method: string;
    params: Record<string, unknown>;
  };
  "plugin://workspace-cancelled": { requestId: string };
}

export const nativeEvents = createEventBus<NativeEvents>(
  (name, receive) => {
    if (
      import.meta.env.DEV &&
      import.meta.env.VITE_TUNNELDE_DEBUGGER === "1" &&
      window.__TUNNELDE_DEBUGGER_MOCK__
    ) {
      return import("@/debugger/mock").then(({ listenFixture }) =>
        listenFixture(name, receive as (payload: unknown) => void),
      );
    }
    return listen(name, ({ payload }) => receive(payload));
  },
  (name, error) => reportError("events.native", name, error),
);

if (import.meta.hot) import.meta.hot.dispose(() => nativeEvents.dispose());
