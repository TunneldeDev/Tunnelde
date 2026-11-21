import type { ComponentProps } from "react";
import { ConfigurationBackupsView } from "./ConfigurationBackupsView";
import { mainConfigurationServices } from "../runtime/mainServices";
export function ConfigurationBackups(
  props: Omit<ComponentProps<typeof ConfigurationBackupsView>, "services">,
) {
  return <ConfigurationBackupsView {...props} services={mainConfigurationServices} />;
}
