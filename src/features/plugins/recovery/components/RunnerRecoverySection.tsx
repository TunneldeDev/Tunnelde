import { RunnerRecoverySectionView } from "./RunnerRecoverySectionView";
import { mainRunnerRecoveryServices } from "../runtime/mainServices";
export function RunnerRecoverySection() {
  return <RunnerRecoverySectionView services={mainRunnerRecoveryServices} />;
}
