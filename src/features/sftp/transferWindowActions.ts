import { api } from "@/lib/api/ipc";
import { createReviewedConnection } from "@/lib/api/connections/review";
import { connectionPromptHost } from "@/features/connect/prompt";
import { useHosts } from "@/store/hosts";
import { useSsh } from "@/store/ssh";
import { useTransfers, type TransferItem, type TransferOperationOptions } from "@/store/transfers";
import { useWorkspace } from "@/store/workspace";
import { usePanelWindows } from "@/store/panelWindows";
import { useTaskProjection, type createTaskProjection } from "@/lib/panels/taskProjection";
import type { PanelLease } from "@/lib/panels/windowProtocol";
import { parentOf } from "@/lib/files/dnd";
import { transferNeedsReview } from "@/lib/files/transferRecovery";
import { transferEndpoint, transferLocation } from "./transferView";
import type {
  TransferPromptPlan,
  TransferWindowAction,
  TransferResumeResult,
} from "./transferWindowProtocol";
import i18n from "@/i18n/i18n";

const sameLease = (a: PanelLease, b: PanelLease) =>
  a.panelId === b.panelId && a.windowId === b.windowId && a.generation === b.generation;
type Projection = Pick<ReturnType<typeof createTaskProjection>, "resolve">;
interface Prompt {
  lease: PanelLease;
  key: string;
  ticket: string;
  interaction: string;
  hostId: string;
  source: boolean;
  reviewed: ReturnType<typeof createReviewedConnection>;
  plan?: Promise<TransferPromptPlan>;
  deadline: number;
  busy: boolean;
  tests: Map<string, string>;
  cancelledTests: Set<string>;
}

/** Main-document singleton only. No credentials are retained by this registry;
 * native owns each admitted action's independent fence. Handles are private,
 * lease/task/consent-bound and expire on owner/source loss or idle timeout. */
export function createTransferWindowActions(projection: Projection, showMain: () => Promise<void>) {
  let disposed = false;
  const prompts = new Map<string, Prompt>();
  const resolve = (key: string, ticket: string): TransferItem => {
    if (disposed) throw new Error("panel.window.disposed");
    const task = projection.resolve(key, ticket);
    const item = useTransfers.getState().items.find((item) => item.id === task.id);
    if (task.source !== "transfers" || !item) throw new Error("plugin.backgroundTasks.changed");
    return item;
  };
  const perform = async <T>(run: (options: TransferOperationOptions) => Promise<T>) => {
    let failed = false,
      cause: unknown;
    const value = await run({
      onError: (error) => {
        failed = true;
        cause = error;
      },
    });
    if (failed) throw cause;
    return value;
  };
  const retire = async (id: string) => {
    const prompt = prompts.get(id);
    if (!prompt) return;
    prompts.delete(id);
    // Cancelling quality tests never cancels an already admitted SSH connect,
    // transfer, trust or credential effect, whose native fence survives the UI.
    await Promise.all(
      [...prompt.tests.values()].map((test) => api.sshCancelTest(test).catch(() => {})),
    );
    prompt.tests.clear();
    prompt.cancelledTests.clear();
  };
  const sweep = () => {
    for (const [id, prompt] of prompts) {
      const alive = usePanelWindows
        .getState()
        .snapshot.panels.some((lease) => sameLease(lease, prompt.lease));
      try {
        resolve(prompt.key, prompt.ticket);
        if (alive && (prompt.busy || prompt.tests.size || prompt.deadline > Date.now())) continue;
      } catch {
        /* Source or exact task incarnation was retired. */
      }
      void retire(id);
    }
  };
  const stopTasks = useTaskProjection.subscribe(sweep);
  const stopWindows = usePanelWindows.subscribe(sweep);
  const timer = setInterval(sweep, 30_000);
  const resume = async (
    lease: PanelLease,
    request: Extract<TransferWindowAction, { kind: "transferResume" }>,
  ): Promise<TransferResumeResult> => {
    const item = resolve(request.key, request.ticket);
    if (
      item.clearing ||
      item.pausing ||
      item.cancelling ||
      item.status === "running" ||
      item.pluginId ||
      !item.durable ||
      transferNeedsReview(item.error)
    )
      throw new Error("plugin.backgroundTasks.actionUnavailable");
    if (!["paused", "failed", "cleanupPending"].includes(item.status))
      throw new Error("plugin.backgroundTasks.actionUnavailable");
    if (item.retainedCreation && item.retainedSettlement !== "created") {
      await perform((options) => useTransfers.getState().clear(item.id, options));
      return {};
    }
    const sides =
      item.status === "cleanupPending" ? ["to" as const] : ["from" as const, "to" as const];
    for (const side of sides) {
      const endpoint = transferEndpoint(item, side, useSsh.getState().sessions);
      if (endpoint.local || endpoint.session) continue;
      // Do not reconnect an edited saved host to the old transfer's endpoint.
      const host = useHosts.getState().hosts.find((host) => host.id === endpoint.hostId);
      if (!host || `${host.username}@${host.host}:${host.port}` !== endpoint.address)
        throw new Error("sftp.reconnectRequired");
      sweep();
      if (
        prompts.size >= 16 ||
        [...prompts.values()].some((p) => sameLease(p.lease, lease) && p.key === request.key)
      )
        throw new Error("plugin.backgroundTasks.actionUnavailable");
      const handle = crypto.randomUUID();
      prompts.set(handle, {
        lease,
        key: request.key,
        ticket: request.ticket,
        interaction: request.interaction,
        hostId: host.id,
        source: !!host.source,
        reviewed: createReviewedConnection(host),
        deadline: Date.now() + 300_000,
        busy: false,
        tests: new Map(),
        cancelledTests: new Set(),
      });
      return { prompt: { handle, host: connectionPromptHost(host) } };
    }
    if (item.status === "cleanupPending")
      await perform((options) => useTransfers.getState().clear(item.id, options));
    else await perform((options) => useTransfers.getState().resume(item.id, options));
    return {};
  };
  return {
    async execute(lease: PanelLease, request: TransferWindowAction): Promise<unknown> {
      const item = resolve(request.key, request.ticket);
      if (request.kind === "transferResume") return resume(lease, request);
      if (request.kind === "transfer") {
        const command = request.command;
        if (command.operation === "inspect") {
          const path = transferLocation(item, command.location);
          const endpoint = transferEndpoint(
            item,
            command.location === "from" ? "from" : "to",
            useSsh.getState().sessions,
          );
          if (!path || (!endpoint.local && !endpoint.session))
            throw new Error("sftp.reconnectRequired");
          const session = endpoint.session;
          useWorkspace.getState().openFilePane(
            {
              source: session ? { kind: "remote", sessionId: session.id } : { kind: "local" },
              path: session ? path.slice(0, path.lastIndexOf("/")) || "/" : parentOf(path),
              ownerSessionId: session?.id ?? "local",
              remoteIdentity: session
                ? { hostId: session.hostId, address: session.address }
                : undefined,
            },
            session?.title ?? i18n.t("sftp.thisComputer"),
          );
          await showMain();
          return null;
        }
        if (item.clearing || item.pausing || item.cancelling)
          throw new Error("plugin.backgroundTasks.actionUnavailable");
        const store = useTransfers.getState();
        switch (command.operation) {
          case "pause":
            if (item.status !== "running" || !item.durable || item.pluginId)
              throw new Error("plugin.backgroundTasks.actionUnavailable");
            await perform((options) => store.pause(item.id, options));
            break;
          case "cancel":
            if (item.status !== "running")
              throw new Error("plugin.backgroundTasks.actionUnavailable");
            await perform((options) => store.cancel(item.id, options));
            break;
          case "clear":
            if (item.status === "running")
              throw new Error("plugin.backgroundTasks.actionUnavailable");
            await perform((options) => store.clear(item.id, options));
            break;
          case "speedLimit":
            if (item.status !== "running")
              throw new Error("plugin.backgroundTasks.actionUnavailable");
            return perform((options) => store.setSpeedLimit(item.id, command.kib, options));
        }
        return null;
      }
      const prompt = prompts.get(request.handle);
      if (
        !prompt ||
        !sameLease(prompt.lease, lease) ||
        prompt.key !== request.key ||
        prompt.ticket !== request.ticket ||
        prompt.interaction !== request.interaction ||
        prompt.deadline < Date.now()
      )
        throw new Error("panel.window.staleOwner");
      prompt.deadline = Date.now() + 300_000;
      const command = request.command,
        reviewed = prompt.reviewed;
      if (command.operation === "close") {
        await retire(request.handle);
        return null;
      }
      if (command.operation === "cancelTest") {
        const id = prompt.tests.get(command.id);
        if (id) await api.sshCancelTest(id);
        else {
          // Claim order is not queue order. A cancel may beat its test; retain
          // a bounded prompt-local tombstone, never cancel an unrelated UUID.
          if (prompt.cancelledTests.size >= 16)
            prompt.cancelledTests.delete(prompt.cancelledTests.values().next().value!);
          prompt.cancelledTests.add(command.id);
        }
        return null;
      }
      const prepare = () =>
        (prompt.plan ??= reviewed.prepare().then(async (plan) => {
          const hosts = [
            ...(prompt.source ? [] : [prompt.hostId]),
            ...plan.jumpHosts.filter((host) => !host.source).map((host) => host.id),
          ];
          const saved = Object.fromEntries(
            await Promise.all(hosts.map(async (id) => [id, await api.credentialStatus(id)])),
          );
          return { jumpHosts: plan.jumpHosts.map(connectionPromptHost), saved };
        }));
      if (command.operation === "prepare") return prepare();
      let testId: string | undefined;
      if (command.operation === "test") {
        if (prompt.cancelledTests.delete(command.id)) throw new Error("ssh.testCancelled");
        if (prompt.tests.size || prompt.busy)
          throw new Error("plugin.backgroundTasks.actionUnavailable");
        // Native diagnostics require a UUID. Namespace it by a private per-
        // prompt mapping, not a string prefix or a caller-chosen native ID.
        testId = crypto.randomUUID();
        prompt.tests.set(command.id, testId);
      }
      try {
        // Only an active route may receive credentials. A caller cannot use a
        // prompt handle as a keychain/SSH proxy for an arbitrary saved host.
        const plan = await reviewed.prepare();
        const routeIds = new Set([prompt.hostId, ...plan.jumpHosts.map((host) => host.id)]);
        if (
          "credentials" in command &&
          Object.keys(command.credentials).some((id) => id === prompt.hostId || !routeIds.has(id))
        )
          throw new Error("ssh.connectionChanged");
        if (command.operation === "credential" && !routeIds.has(command.hostId))
          throw new Error("ssh.connectionChanged");
        if (command.operation === "trust" && !routeIds.has(command.expectedHostId))
          throw new Error("ssh.connectionChanged");
        // These awaits only prepare immutable reviewed metadata; re-resolve before
        // starting any effect, so a disappearing task cannot authorize a new one.
        resolve(request.key, request.ticket);
        if (prompts.get(request.handle) !== prompt) throw new Error("panel.window.staleOwner");
        if (command.operation === "test") return await reviewed.test(testId!, command.credentials);
        if (prompt.busy || prompt.tests.size)
          throw new Error("plugin.backgroundTasks.actionUnavailable");
        prompt.busy = true;
        try {
          switch (command.operation) {
            case "probe":
              return await reviewed.probe(command.credentials);
            case "trust":
              return await reviewed.trust(
                command.fingerprint,
                command.credentials,
                command.expectedHostId,
              );
            case "credential":
              await reviewed.credential(command.hostId, command.password);
              return null;
            case "installKey": {
              await reviewed.installKey(command.password, command.credentials);
              await useHosts.getState().load();
              return null;
            }
            case "connect": {
              let cause: unknown;
              const session = await useSsh.getState().connect(
                {
                  hostId: prompt.hostId,
                  background: true,
                  cols: 120,
                  rows: 32,
                  password: command.password,
                  passphrase: command.passphrase,
                  jumpCredentials: command.credentials,
                },
                (error) => {
                  cause = error;
                },
                { key: reviewed.key, connect: reviewed.connect },
              );
              if (!session) throw cause ?? new Error("sftp.reconnectRequired");
              const { id, hostId, title, address, cols, rows, connectedAt, terminal, purpose } =
                session;
              return { id, hostId, title, address, cols, rows, connectedAt, terminal, purpose };
            }
          }
        } finally {
          prompt.busy = false;
        }
      } finally {
        if (command.operation === "test" && prompt.tests.get(command.id) === testId)
          prompt.tests.delete(command.id);
      }
    },
    dispose() {
      disposed = true;
      clearInterval(timer);
      stopTasks();
      stopWindows();
      for (const id of prompts.keys()) void retire(id);
    },
  };
}
