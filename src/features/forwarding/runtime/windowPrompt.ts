import type { ConnectionReview } from "@/lib/api/connections/review";
import {
  isIpcError,
  type ConnectionQuality,
  type HostKeyInfo,
  type SshSession,
} from "@/lib/api/types";
import type { createNativePluginViewClient } from "@/lib/panels/windowPluginClient";
import type { PanelWindowClient } from "@/lib/panels/windowClient";
import type { PanelLease } from "@/lib/panels/windowProtocol";
import { createPanelWindowInteraction } from "@/lib/panels/windowInteraction";
import type { ConnectionPromptHost, ConnectionPromptServices } from "@/features/connect/prompt";
import type { ForwardingWindowMutation, ForwardingWindowStartPlan } from "./windowProtocol";

export interface WindowForwardingBatchResult {
  started: { id: string; session: SshSession }[];
  failed: { id: string; error: unknown }[];
}
export interface WindowForwardingPrompt {
  host: ConnectionPromptHost;
  services: ConnectionPromptServices;
  result(): WindowForwardingBatchResult;
}
export type NativeForwardingPromptClient = Pick<
  ReturnType<typeof createNativePluginViewClient>,
  "forwardingMutation"
>;
export type WindowForwardingPromptTarget = { id: string; revision: string; hostId: string };

function display({
  id,
  name,
  host,
  port,
  username,
  authMethod,
  source,
}: ConnectionPromptHost): ConnectionPromptHost {
  return { id, name, host, port, username, authMethod, ...(source ? { source: true } : {}) };
}

/** One original builtin prompt, not a provider adapter or serialized draft.
 * Acquire before mounting consent UI. close() also retires a late acquisition;
 * native actual-effect fences outlive UI disposal independently. */
export function createForwardingWindowPrompt(
  client: PanelWindowClient,
  requestedLease: PanelLease,
  requestedTarget: WindowForwardingPromptTarget,
  followingTargets: readonly WindowForwardingPromptTarget[] = [],
) {
  return createWindowPrompt(client, client, requestedLease, requestedTarget, followingTargets);
}

/** The original native provider child is the only mutation route. Main window
 * control supplies consent lifetime only, never a builtin mutation fallback.
 * Child/selection/runtime policy is checked natively at each actual effect. */
export function createForwardingProviderWindowPrompt(
  client: PanelWindowClient,
  provider: NativeForwardingPromptClient,
  requestedLease: PanelLease,
  requestedTarget: WindowForwardingPromptTarget,
  token: string,
  followingTargets: readonly WindowForwardingPromptTarget[] = [],
) {
  const transport: Pick<PanelWindowClient, "forwardingMutation"> = {
    forwardingMutation: async (lease, request) => {
      if (typeof token !== "string" || !token || !provider)
        throw new Error("plugin.forwarding.expired");
      return provider.forwardingMutation(token, lease, request);
    },
  };
  return createWindowPrompt(client, transport, requestedLease, requestedTarget, followingTargets);
}

function createWindowPrompt(
  client: PanelWindowClient,
  transport: Pick<PanelWindowClient, "forwardingMutation">,
  requestedLease: PanelLease,
  requestedTarget: WindowForwardingPromptTarget,
  followingTargets: readonly WindowForwardingPromptTarget[],
) {
  const { lease, acquired, check, close } = createPanelWindowInteraction(client, requestedLease);
  const target = {
    id: requestedTarget.id,
    revision: requestedTarget.revision,
    hostId: requestedTarget.hostId,
  };
  const targets = [
    target,
    ...followingTargets.map(({ id, revision, hostId }) => ({ id, revision, hostId })),
  ];
  const started = new Map<string, SshSession>();
  let failures: WindowForwardingBatchResult["failed"] = [];
  const result = (): WindowForwardingBatchResult => ({
    started: [...started].map(([id, session]) => ({ id, session: { ...session } })),
    failed: failures.map((entry) => ({ ...entry })),
  });
  let interaction = "";
  let review: ConnectionReview;
  let jumps: ConnectionPromptHost[] = [];
  let allowedHosts = new Set<string>();
  let tail: Promise<unknown> = Promise.resolve();
  const tests = new Map<string, { cancelled: boolean; finished: boolean }>();
  const base = () => ({
    id: target.id,
    revision: target.revision,
    interaction,
    review: { ...review },
  });
  const send = async <T>(request: ForwardingWindowMutation): Promise<T> => {
    check();
    const value = await transport.forwardingMutation<T>(lease, request);
    check();
    return value;
  };
  const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
    check();
    const work = tail.then(async () => {
      check();
      return operation();
    });
    // Initial prompt effects run concurrently in React; native permits one
    // actual effect per panel. A rejected job must not poison the next one.
    tail = work.catch(() => {});
    return work;
  };
  const enqueue = <T>(request: () => ForwardingWindowMutation, accepted?: (value: T) => void) =>
    serialize(async () => {
      const value = await send<T>(request());
      accepted?.(value);
      return value;
    });
  const hostAllowed = (id: string) => {
    if (!allowedHosts.has(id)) throw new Error("ssh.connectionChanged");
  };
  const services = Object.freeze<ConnectionPromptServices>({
    prepare: async () => {
      check();
      return { jumpHosts: structuredClone(jumps) };
    },
    credentialStatus: async (hostId) => {
      hostAllowed(hostId);
      return enqueue<boolean>(() => ({ ...base(), operation: "credentialStatus", hostId }));
    },
    probe: async (input) => {
      const credentials = structuredClone(input);
      return enqueue<HostKeyInfo>(() => ({ ...base(), operation: "probe", credentials }));
    },
    trust: async (fingerprint, input, expectedHostId) => {
      hostAllowed(expectedHostId);
      const credentials = structuredClone(input);
      const result = await enqueue<{ info: HostKeyInfo; review: ConnectionReview }>(
        () => ({ ...base(), operation: "trust", fingerprint, credentials, expectedHostId }),
        (trusted) => {
          review = { ...trusted.review };
        },
      );
      return result.info;
    },
    connect: async (input) => {
      if (input.hostId !== target.hostId) throw new Error("ssh.connectionChanged");
      // Native owns background purpose, grouping, endpoint and terminal fields.
      // No arbitrary request field or caller-selected SSH identity is relayed.
      const credentials = structuredClone({
        password: input.password ?? null,
        passphrase: input.passphrase ?? null,
        jumps: input.jumpCredentials ?? {},
      });
      return serialize(async () => {
        // A callback failure must not turn Connect into replay of acknowledged
        // listeners (nor report a cached, possibly disconnected SSH session).
        if (started.size) throw new Error("forward.alreadyActive");
        failures = [];
        for (const current of targets) {
          check();
          try {
            // Each rule keeps its original revision, but shares ONLY the route
            // already reviewed by this prompt. Never silently adopt a new host
            // route or a replacement rule after a previous item yielded.
            if (current !== target) {
              const plan = await send<ForwardingWindowStartPlan>({
                operation: "prepareStart",
                id: current.id,
                revision: current.revision,
                interaction,
              });
              if (
                plan.host.source ||
                plan.jumpHosts.some((host) => host.source) ||
                plan.host.id !== target.hostId ||
                plan.review.hostId !== review.hostId ||
                plan.review.revision !== review.revision
              )
                throw new Error("ssh.connectionChanged");
            }
            const session = await send<SshSession>({
              operation: "start",
              id: current.id,
              revision: current.revision,
              interaction,
              review: { ...review },
              credentials,
            });
            started.set(current.id, session);
          } catch (error) {
            check();
            const message =
              error instanceof Error
                ? error.message
                : isIpcError(error)
                  ? error.message
                  : String(error);
            if (
              /^(plugin|extension\.scope|panel|stale panel owner|invalid (?:window|document|interaction)|document )/.test(
                message,
              )
            )
              throw error;
            // One invalid credential/trust decision applies to the whole host.
            // Do not repeat it across groups and trigger account lockouts.
            if (
              /^ssh\.(passwordRequired|passphraseRequired|authFailed|authenticationFailed|hostKeyUntrusted|hostKeyChanged|keyPassphraseRequired|keyAuthFailed|keyLoad|agentUnavailable)/.test(
                message,
              )
            )
              throw error;
            failures.push({ id: current.id, error });
          }
        }
        const connected = started.values().next().value;
        if (!connected) throw failures[0]?.error ?? new Error("forward.missing");
        return connected;
      });
    },
    test: async (testId, input) => {
      check();
      if (tests.has(testId)) throw new Error("ssh.testCancelled");
      if (tests.size >= 64) throw new Error("ssh.sessionBusy");
      const record = { cancelled: false, finished: false };
      tests.set(testId, record);
      const credentials = structuredClone(input);
      try {
        return await enqueue<ConnectionQuality>(() => {
          if (record.cancelled) throw new Error("ssh.testCancelled");
          return { ...base(), operation: "test", testId, credentials };
        });
      } finally {
        record.finished = true;
      }
    },
    cancelTest: async (testId) => {
      const record = tests.get(testId);
      if (record?.finished) return;
      if (record) record.cancelled = true;
      else {
        check();
        if (tests.size >= 64) throw new Error("ssh.sessionBusy");
        tests.set(testId, { cancelled: true, finished: false });
      }
      // Cleanup must bypass the occupied operation queue, including a queued
      // start. Correlation stays bound to this ORIGINAL interaction, never a
      // global ssh_cancel_test ID or another prompt's replacement consent.
      await transport.forwardingMutation(lease, { operation: "cancelTest", testId, interaction });
    },
    credential: async (hostId, password) => {
      hostAllowed(hostId);
      await enqueue(() =>
        password === null
          ? { ...base(), operation: "forgetCredential", hostId }
          : { ...base(), operation: "saveCredential", hostId, password },
      );
    },
    installKey: async (password, input) => {
      const credentials = structuredClone(input);
      return enqueue<null>(() => ({ ...base(), operation: "installKey", password, credentials }));
    },
  });
  const ready = acquired
    .then(async (id): Promise<WindowForwardingPrompt> => {
      interaction = id;
      check();
      if (
        targets.some((item) => !item.id || !item.revision || item.hostId !== target.hostId) ||
        new Set(targets.map((item) => item.id)).size !== targets.length
      )
        throw new Error("forward.changed");
      const plan = await transport.forwardingMutation<ForwardingWindowStartPlan>(lease, {
        operation: "prepareStart",
        id: target.id,
        revision: target.revision,
        interaction,
      });
      check();
      // Both routes are limited to builtin hosts. The provider route keeps its
      // original native child; never downgrade or hydrate writable host stores.
      if (
        plan.host.source ||
        plan.jumpHosts.some((host) => host.source) ||
        plan.host.id !== target.hostId ||
        plan.review.hostId !== target.hostId
      )
        throw new Error("panel.window.unsupportedView");
      review = { ...plan.review };
      jumps = plan.jumpHosts.map(display);
      allowedHosts = new Set([target.hostId, ...jumps.map((host) => host.id)]);
      return { host: display(plan.host), services, result };
    })
    .catch(async (error: unknown) => {
      try {
        await close();
      } catch (cleanup) {
        throw new AggregateError([error, cleanup], "panel.window.cleanupFailed");
      }
      throw error;
    });
  return Object.freeze({ ready, close });
}
