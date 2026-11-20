import type { ConnectionReview } from "@/lib/api/connections/review";
import type { ConnectionQuality, HostKeyInfo, SshSession } from "@/lib/api/types";
import type { PanelWindowClient } from "@/lib/panels/windowClient";
import type { PanelLease } from "@/lib/panels/windowProtocol";
import { createPanelWindowInteraction } from "@/lib/panels/windowInteraction";
import type { ConnectionPromptHost, ConnectionPromptServices } from "@/features/connect/prompt";
import type { ForwardingWindowMutation, ForwardingWindowStartPlan } from "./windowProtocol";

export interface WindowForwardingPrompt {
  host: ConnectionPromptHost;
  services: ConnectionPromptServices;
}
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
) {
  const { lease, acquired, check, close } = createPanelWindowInteraction(client, requestedLease);
  const target = {
    id: requestedTarget.id,
    revision: requestedTarget.revision,
    hostId: requestedTarget.hostId,
  };
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
  const enqueue = <T>(
    request: () => ForwardingWindowMutation,
    accepted?: (result: T) => void,
  ): Promise<T> => {
    check();
    const work = tail.then(async () => {
      check();
      const result = await client.forwardingMutation<T>(lease, request());
      check();
      accepted?.(result);
      return result;
    });
    // Initial prompt effects run concurrently in React; native permits one
    // actual effect per panel. A rejected job must not poison the next one.
    tail = work.catch(() => {});
    return work;
  };
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
      return enqueue<SshSession>(() => ({ ...base(), operation: "start", credentials }));
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
      await client.forwardingMutation(lease, { operation: "cancelTest", testId, interaction });
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
      const plan = await client.forwardingMutation<ForwardingWindowStartPlan>(lease, {
        operation: "prepareStart",
        id: target.id,
        revision: target.revision,
        interaction,
      });
      check();
      // Provider prompts require native provider handles. Never downgrade them
      // to this builtin route or hydrate full host/credential stores.
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
      return { host: display(plan.host), services };
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
