import type { ReactNode } from "react";
import type { runnerRecoveryApi } from "@/lib/api/runners/recovery";
import type { RecoveryEntry } from "@/lib/runners/recovery/contracts";
import type { SettingsControlState } from "@/features/settings/components/controlState";
export interface RecoveryPageServices {
  client: Pick<typeof runnerRecoveryApi, "snapshot" | "action">;
  useViewState: SettingsControlState;
  useBusyGuard(busy: boolean): void;
}
export interface RecoveryFileBinding {
  pending: boolean;
  error: string | null;
  browse(entry: RecoveryEntry): Promise<void>;
  /** Main renders its real connection/auth dialog; native views delegate to that owner. */
  renderConnection(): ReactNode;
}
export interface RunnerRecoveryServices extends RecoveryPageServices {
  client: RecoveryPageServices["client"] & Pick<typeof runnerRecoveryApi, "owners">;
  useFiles(pluginId: string): RecoveryFileBinding;
  openLog(): Promise<void>;
}
