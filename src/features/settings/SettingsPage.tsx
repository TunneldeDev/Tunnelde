import { SettingsPageView } from "./SettingsPageView";
import { mainSettingsPageServices } from "./mainSettingsPageServices";
/** Main composition retains the singleton settings writer, consent and providers. */
export function SettingsPage({ visible = true }: { visible?: boolean }) {
  return <SettingsPageView visible={visible} services={mainSettingsPageServices} />;
}
