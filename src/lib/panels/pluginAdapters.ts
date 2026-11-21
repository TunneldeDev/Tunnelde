import type { FrontendViewOwner } from "@/lib/extensions/runtime/views/frontend";
import type { NativePanelSnapshot, NativePluginViewDescriptor } from "./windowProtocol";
import type { createNativePluginViewClient } from "./windowPluginClient";

export interface PluginAdapterCandidate {
  panelId: string;
  viewId: string;
  owner: FrontendViewOwner;
}
export interface DeclarativeAdapterCandidate {
  panelId: string;
  pluginId: string;
  runtimeId: string;
  viewId: string;
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
  declarative: readonly DeclarativeAdapterCandidate[] = [],
  declarativeClient?: {
    registerAdapter(pluginId: string, runtimeId: string, viewId: string): Promise<unknown>;
    unregisterAdapter(descriptor: {
      panelId: string;
      runtimeId: string;
      generation: number;
      revision: string;
    }): Promise<unknown>;
  },
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
  if (!declarativeClient) return;
  const desiredDeclarative = declarative.filter((candidate) => panels.has(candidate.panelId));
  for (const descriptor of snapshot.declarativeViews ?? [])
    if (
      !desiredDeclarative.some(
        (candidate) =>
          candidate.panelId === descriptor.panelId &&
          candidate.pluginId === descriptor.pluginId &&
          candidate.runtimeId === descriptor.runtimeId &&
          candidate.viewId === descriptor.viewId,
      ) &&
      snapshot.panels.some((panel) => panel.panelId === descriptor.panelId)
    )
      await declarativeClient.unregisterAdapter(descriptor);
  for (const candidate of desiredDeclarative)
    if (
      !snapshot.declarativeViews?.some(
        (descriptor) =>
          descriptor.panelId === candidate.panelId &&
          descriptor.pluginId === candidate.pluginId &&
          descriptor.runtimeId === candidate.runtimeId &&
          descriptor.viewId === candidate.viewId,
      )
    )
      await declarativeClient.registerAdapter(
        candidate.pluginId,
        candidate.runtimeId,
        candidate.viewId,
      );
}
