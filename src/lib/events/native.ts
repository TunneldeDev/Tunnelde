import { listen } from "@tauri-apps/api/event";
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

export interface NativeEvents {
  "plugin://event": PluginEvent;
  "plugin:security-changed": PluginSecurityState;
  "plugins://download": PluginDownload;
  "plugins://config": PluginConfig;
  "settings://changed": Settings;
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
  "plugin://domain-changed": { domain: string; sessionId?: string | null };
  "plugin://workspace-request": {
    requestId: string;
    pluginId: string;
    method: string;
    params: Record<string, unknown>;
  };
  "plugin://workspace-cancelled": { requestId: string };
}

export const nativeEvents = createEventBus<NativeEvents>(
  (name, receive) => listen(name, ({ payload }) => receive(payload)),
  (name) => console.error(`Event handler failed: ${name}`),
);

if (import.meta.hot) import.meta.hot.dispose(() => nativeEvents.dispose());
