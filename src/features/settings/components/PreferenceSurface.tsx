import type { ComponentProps } from "react";
import { ProviderSurface } from "@/components/layout/ProviderSurface";
import { useSettings } from "@/store/settings";
import { PreferenceSurfaceView, type PreferenceSurfaceServices } from "./PreferenceSurfaceView";
const services: PreferenceSurfaceServices = {
  useData() {
    const settings = useSettings((state) => state.settings);
    const busy = useSettings((state) => state.saving);
    const error = useSettings((state) => state.error);
    return { settings, busy, error };
  },
  isCurrent: (settings) => useSettings.getState().settings === settings,
  Provider: ({ context, visible, children }) => (
    <ProviderSurface target="preferences" preferences={context} visible={visible}>
      {children}
    </ProviderSurface>
  ),
};
/** Selected and legacy providers remain real owner contributions, never silently omitted. */
export function PreferenceSurface(
  props: Omit<ComponentProps<typeof PreferenceSurfaceView>, "services">,
) {
  return <PreferenceSurfaceView {...props} services={services} />;
}
