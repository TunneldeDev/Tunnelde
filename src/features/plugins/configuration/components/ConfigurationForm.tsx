import type { ComponentProps } from "react";
import { ConfigurationFormView } from "./ConfigurationFormView";
import { mainConfigurationServices } from "../runtime/mainServices";
export function ConfigurationForm(
  props: Omit<ComponentProps<typeof ConfigurationFormView>, "services">,
) {
  return <ConfigurationFormView {...props} services={mainConfigurationServices} />;
}
