import type { FrontendViewOwner } from "@/lib/extensions/runtime/views/frontend";
import type { NativePanelSnapshot, NativePluginViewDescriptor } from "./windowProtocol";
import type { createNativePluginViewClient } from "./windowPluginClient";

export interface PluginAdapterCandidate {
  panelId: string;
  viewId: string;
  owner: FrontendViewOwner;
}
export const samePluginAdapter = (
  descriptor: NativePluginViewDescriptor,
  candidate: PluginAdapterCandidate,
) =>
  descriptor.panelId === candidate.panelId &&
  descriptor.viewId === candidate.viewId &&
  descriptor.pluginId === candidate.owner.pluginId &&
  descriptor.runtimeId === candidate.owner.runtimeId &&
  descriptor.generation === candidate.owner.generation &&
  descriptor.entry === candidate.owner.entry &&
  descriptor.sdkVersion === candidate.owner.sdkVersion;

/** Called in the coordinator's serialized reconciliation, before any factory is
 * mounted. A changing candidate set queues another reconciliation; native still
 * rechecks current authority after each asynchronous source review. */
export async function synchronizePluginAdapters(
  client: Pick<
    ReturnType<typeof createNativePluginViewClient>,
    "registerAdapter" | "unregisterAdapter"
  >,
  snapshot: NativePanelSnapshot,
  candidates: readonly PluginAdapterCandidate[],
) {
  const panels = new Set(snapshot.panels.map((panel) => panel.panelId));
  const desired = candidates.filter((candidate) => panels.has(candidate.panelId));
  for (const descriptor of snapshot.pluginViews ?? [])
    if (!desired.some((candidate) => samePluginAdapter(descriptor, candidate)))
      await client.unregisterAdapter(descriptor);
  for (const candidate of desired)
    if (!snapshot.pluginViews?.some((descriptor) => samePluginAdapter(descriptor, candidate)))
      await client.registerAdapter(
        candidate.owner.pluginId,
        candidate.owner.runtimeId,
        candidate.viewId,
      );
}
