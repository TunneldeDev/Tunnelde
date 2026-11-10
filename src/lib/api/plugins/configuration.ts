import { invoke } from "@tauri-apps/api/core";
import type {
  ConfigurationSnapshot,
  ConfigurationUpdate,
  ConfigurationExpected,
  ConfigurationBackup,
  ConfigurationBackupRequest,
} from "@/lib/extensions/contracts/configuration/document";

export const pluginConfigurationApi = {
  get: (pluginId: string, fingerprint: string) =>
    invoke<ConfigurationSnapshot>("plugin_configuration_get", { pluginId, fingerprint }),
  update: (pluginId: string, fingerprint: string, update: ConfigurationUpdate) =>
    invoke<ConfigurationSnapshot>("plugin_configuration_update", { pluginId, fingerprint, update }),
  migrate: (pluginId: string, fingerprint: string, expected: ConfigurationExpected) =>
    invoke<ConfigurationSnapshot>("plugin_configuration_migrate", {
      pluginId,
      fingerprint,
      expected,
    }),
  backups: (pluginId: string, fingerprint: string) =>
    invoke<ConfigurationBackup[]>("plugin_configuration_backups", { pluginId, fingerprint }),
  restore: (pluginId: string, fingerprint: string, request: ConfigurationBackupRequest) =>
    invoke<ConfigurationSnapshot>("plugin_configuration_restore", {
      pluginId,
      fingerprint,
      request,
    }),
  deleteBackup: (pluginId: string, fingerprint: string, request: ConfigurationBackupRequest) =>
    invoke<void>("plugin_configuration_delete_backup", { pluginId, fingerprint, request }),
};
