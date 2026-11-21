import { useLayoutEffect, type ComponentType } from "react";
import type { FrontendViewProps } from "../../contracts/frontend/views";
import type { ResourceScope } from "../scopes/contracts";
import { useFactoryPanelState } from "./factoryState";

/** A registered renderer has no capture/restore contract. Keep its exact source
 * component/scope and require per-instance state-loss consent; never invent an
 * empty state or run singleton activation again to simulate a remote factory.
 * This source adapter does not itself make a legacy module remotely renderable.
 */
export function LegacyPanelView({
  View,
  viewProps,
  resources,
}: {
  View: ComponentType<FrontendViewProps>;
  viewProps: FrontendViewProps;
  resources: ResourceScope;
}) {
  const { initial, current } = useFactoryPanelState(
    viewProps.pluginId,
    viewProps.viewId,
    resources.signal,
  );
  if (initial !== undefined) throw new Error("plugin.frontend.viewStateUnavailable");
  useLayoutEffect(() => {
    current.current?.rendered({
      component: View,
      resources,
      stateful: false,
      captureState: async () => {
        throw new Error("plugin.frontend.viewStateUnavailable");
      },
      // The original mount, not a capture binding, owns the resource scope.
      dispose() {},
    });
  }, [current, View, resources]);
  return <View {...viewProps} resources={resources} />;
}
