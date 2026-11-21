import { useRecoveryPageModel } from "./useRecoveryPageModel";
import { mainRecoveryPageServices } from "./mainPageServices";
export function useRecoveryPage(pluginId: string, offset: number) {
  return useRecoveryPageModel(pluginId, offset, mainRecoveryPageServices);
}
