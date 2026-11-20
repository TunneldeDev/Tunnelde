import type { PanelWindowClient } from "@/lib/panels/windowClient";
import type { PanelLease } from "@/lib/panels/windowProtocol";
import type { ForwardingAuthority } from "@/lib/extensions/forwarding/authority";
import type { ForwardingActions } from "./actions";
import type { ForwardInfo } from "../model/contract";
import { forwardingSavePayload } from "../model/payload";
import type { ForwardingWindowMutation } from "./windowProtocol";
import {
  createForwardingWindowPrompt,
  createForwardingProviderWindowPrompt,
  type NativeForwardingPromptClient,
} from "./windowPrompt";

type Provider = {
  hostId: string;
  token: string;
  client: NativeForwardingPromptClient;
  check(): void;
};

/** Document-local action composition. Never hydrates or mutates main stores.
 * Provider continuations are private object identities, not bearer origins.
 * The parent owns native child disposal; this service only retires its callbacks.
 */
export function createWindowForwardingActions(
  client: PanelWindowClient,
  requestedLease: PanelLease,
  options: { check(): void; refresh(): void; report(error: unknown): void },
) {
  const lease = Object.freeze({
    panelId: requestedLease.panelId,
    windowId: requestedLease.windowId,
    generation: requestedLease.generation,
  });
  const owner = { ...options };
  const scopes = new Set<ReturnType<typeof createForwardingWindowPrompt>>();
  const providers = new WeakMap<ForwardingAuthority, Provider>();
  let disposed = false;
  const check = () => {
    if (disposed) throw new Error("panel.window.disposed");
    owner.check();
  };
  const providerFor = (authority?: ForwardingAuthority, hostId?: string) => {
    check();
    if (!authority) return undefined;
    const provider = providers.get(authority);
    if (!provider || (hostId !== undefined && hostId !== provider.hostId))
      throw new Error("plugin.forwarding.expired");
    provider.check();
    return provider;
  };
  const send = async <T>(
    request: ForwardingWindowMutation,
    authority?: ForwardingAuthority,
    hostId?: string,
  ): Promise<T> => {
    // Snapshot editable input before any transport wait. A changed frame never
    // substitutes a different child, target, revision or consent token.
    const captured = structuredClone(request);
    const provider = providerFor(authority, hostId);
    const value = provider
      ? await provider.client.forwardingMutation<T>(provider.token, lease, captured)
      : await client.forwardingMutation<T>(lease, captured);
    providerFor(authority, hostId);
    return value;
  };
  const original = (interaction?: string) => {
    if (!interaction) throw new Error("panel.window.staleOwner");
    return interaction;
  };
  const actions = Object.freeze<ForwardingActions>({
    refresh() {
      check();
      owner.refresh();
    },
    async start(rule, authority, request, review) {
      // Interactive credentials belong to the already-acquired native prompt,
      // not a request/review from the main document's ConnectDialog. Auto-start
      // attempts use native stored credentials and surface auth failures to UI.
      if (request || review) throw new Error("panel.window.unsupportedView");
      const target = { id: rule.id, revision: rule.revision, hostId: rule.hostId };
      const provider = providerFor(authority, target.hostId);
      const scope = provider
        ? createForwardingProviderWindowPrompt(
            client,
            provider.client,
            lease,
            target,
            provider.token,
          )
        : createForwardingWindowPrompt(client, lease, target);
      scopes.add(scope);
      let connected;
      try {
        const prompt = await scope.ready;
        providerFor(authority, target.hostId);
        connected = await prompt.services.connect({ hostId: target.hostId, cols: 80, rows: 24 });
        providerFor(authority, target.hostId);
        if (!connected) throw new Error("ssh.sessionMissing");
      } catch (cause) {
        try {
          await scope.close();
          scopes.delete(scope);
        } catch (cleanup) {
          throw new AggregateError([cause, cleanup], "panel.window.cleanupFailed");
        }
        throw cause;
      }
      await scope.close();
      scopes.delete(scope);
      providerFor(authority, target.hostId);
      return connected;
    },
    async save(rule, revision, authority, interaction) {
      // Existing configured rules must carry the displayed automation values;
      // omitting them must not silently disable auto-start/retry on edit.
      if (rule.id && (!revision || !rule.automation)) throw new Error("forward.changed");
      return send(
        {
          operation: "save",
          rule: forwardingSavePayload(rule),
          revision: rule.id ? revision! : null,
          groupId: rule.groupId ?? null,
          automation: {
            autoStart: rule.automation?.autoStart ?? false,
            autoRetry: rule.automation?.autoRetry ?? false,
          },
          ...(interaction ? { interaction } : {}),
        },
        authority,
        rule.hostId,
      );
    },
    async remove(rule, authority, interaction) {
      await send(
        {
          operation: "remove",
          id: rule.id,
          revision: rule.revision,
          runtimeId: (rule as Partial<ForwardInfo>).runtimeId ?? null,
          interaction: original(interaction),
        },
        authority,
        rule.hostId,
      );
    },
    async stop(rule, authority) {
      await send(
        {
          operation: "stop",
          id: rule.id,
          revision: rule.revision,
          runtimeId: rule.runtimeId ?? null,
        },
        authority,
      );
    },
    async disconnect(hostId, sessionId, authority, interaction) {
      await send(
        { operation: "disconnect", hostId, sessionId, interaction: original(interaction) },
        authority,
        hostId,
      );
    },
    async saveGroup(hostId, name, group) {
      if (group && group.hostId !== hostId) throw new Error("forward.changed");
      return send({
        operation: "saveGroup",
        hostId,
        name,
        ...(group ? { id: group.id, revision: group.revision } : {}),
      });
    },
    async removeGroup(group) {
      await send({ operation: "removeGroup", id: group.id, revision: group.revision });
    },
    async copyAddress(text) {
      await send({ operation: "copyAddress", text });
    },
  });
  return Object.freeze({
    actions,
    providerFor: (authority?: ForwardingAuthority) => {
      const provider = providerFor(authority);
      return provider && Object.freeze({ client: provider.client, token: provider.token });
    },
    createProviderAuthority(requested: Provider): ForwardingAuthority {
      check();
      const provider = { ...requested };
      const authorize = () => {
        check();
        provider.check();
      };
      const authority = Object.freeze<ForwardingAuthority>({
        authorize,
        origin: async () => {
          authorize();
          throw new Error("panel.window.unsupportedView");
        },
      });
      providers.set(authority, provider);
      return authority;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const scope of scopes) void scope.close().then(() => scopes.delete(scope), owner.report);
    },
  });
}
