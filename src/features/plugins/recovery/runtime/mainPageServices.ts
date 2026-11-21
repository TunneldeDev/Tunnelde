import { runnerRecoveryApi } from "@/lib/api/runners/recovery";
import { useViewState, useBackgroundGuard } from "@/lib/session/viewState";
import type { RecoveryPageServices } from "../data/services";
export const mainRecoveryPageServices: RecoveryPageServices = {
  client: runnerRecoveryApi,
  useViewState,
  useBusyGuard: useBackgroundGuard,
};
