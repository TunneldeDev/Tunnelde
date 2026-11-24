import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ConnectionPrompt } from "@/features/connect/ConnectionPrompt";
import type { ConnectionPromptServices } from "@/features/connect/prompt";
import type { TaskViewProps } from "@/features/tasks/presentation";
import type { TransferPanelModel } from "@/lib/panels/taskModel";
import { usePanelInteraction, type PanelInteractionRelease } from "@/lib/panels/interaction";
import { presentError } from "@/lib/api/errors";
import { toast } from "@/store/toasts";
import { TransferTask } from "./TransferTask";
import { TransferTaskControllerScope } from "./transferTaskController";
import type {
  TransferPromptOperation,
  TransferPromptPlan,
  TransferResumeResult,
} from "./transferWindowProtocol";

type ActivePrompt = NonNullable<TransferResumeResult["prompt"]>;
/** Presentation only: the coordinator owns transfers, route reviews, test IDs,
 * connections and keychain effects. Moving this view never starts an operation. */
export function WindowTransferTask({
  task,
  now,
  model,
}: TaskViewProps & { model: TransferPanelModel }) {
  const entry = model.entries.find((entry) => entry.key === task.key);
  const acquire = usePanelInteraction();
  const [prompt, setPrompt] = useState<
    (ActivePrompt & { services: ConnectionPromptServices }) | null
  >(null);
  const release = useRef<PanelInteractionRelease | null>(null);
  const currentPrompt = useRef<ActivePrompt | null>(null);
  const mounted = useRef(true);
  const pending = useRef(false);
  const gateway = useRef(model.action);
  useLayoutEffect(() => {
    gateway.current = model.action;
  }, [model.action]);
  const key = task.key,
    ticket = entry?.ticket;
  const sendPrompt = <T,>(active: ActivePrompt, command: TransferPromptOperation): Promise<T> => {
    if (!ticket || !release.current?.id)
      return Promise.reject(new Error("panel.window.staleOwner"));
    return gateway.current<T>({
      kind: "transferPrompt",
      key,
      ticket,
      interaction: release.current.id,
      handle: active.handle,
      command,
    });
  };
  const send = useRef(sendPrompt);
  useLayoutEffect(() => {
    send.current = sendPrompt;
  });
  const end = async () => {
    const guard = release.current;
    if (guard) {
      await guard();
      if (release.current === guard) release.current = null;
    }
  };
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      const active = currentPrompt.current;
      if (active) void send.current(active, { operation: "close" }).catch(() => {});
      // usePanelInteraction independently releases even late acquisitions. Any
      // admitted resource effect keeps its native action fence after unmount.
    };
  }, []);
  const advance = async () => {
    if (!ticket || !release.current?.id) throw new Error("panel.window.staleOwner");
    const result = await gateway.current<TransferResumeResult>({
      kind: "transferResume",
      key,
      ticket,
      interaction: release.current.id,
    });
    if (!mounted.current) {
      if (result.prompt) await sendPrompt(result.prompt, { operation: "close" }).catch(() => {});
      await end();
      return;
    }
    currentPrompt.current = result.prompt ?? null;
    const next = result.prompt;
    setPrompt(
      next
        ? { ...next, services: createPromptServices((command) => send.current(next, command)) }
        : null,
    );
    if (!result.prompt) await end();
  };
  const resume = async () => {
    if (pending.current || currentPrompt.current) return;
    pending.current = true;
    try {
      release.current ??= await acquire();
      if (!mounted.current) {
        await end();
        return;
      }
      await advance();
    } catch (error) {
      await end().catch(() => {});
      throw error;
    } finally {
      pending.current = false;
    }
  };
  const connected = useRef(false);
  const closing = useRef<Promise<void> | null>(null);
  const closePrompt = async () => {
    if (!prompt) return;
    let failure: unknown;
    try {
      await sendPrompt(prompt, { operation: "close" });
    } catch (error) {
      failure = error;
    }
    currentPrompt.current = null;
    if (mounted.current) setPrompt(null);
    // Dismissing a private prompt is always locally possible, even after its
    // task/handle expires. Do not strand an uncloseable modal or consent guard.
    if (failure || !mounted.current) {
      connected.current = false;
      await end();
      if (failure) throw failure;
      return;
    }
    if (connected.current) {
      connected.current = false;
      // Re-resolve both endpoints. Sequential prompts share one consent guard,
      // but never resume via a captured/stale transfer or a new arbitrary host.
      try {
        await advance();
      } catch (error) {
        await end().catch(() => {});
        throw error;
      }
    } else await end();
  };
  const close = () =>
    (closing.current ??= closePrompt().finally(() => {
      closing.current = null;
    }));
  if (!entry?.transfer) return null;
  const { item, inspect } = entry.transfer;
  const control = <T,>(
    command: Extract<Parameters<TransferPanelModel["action"]>[0], { kind: "transfer" }>["command"],
  ) => model.action<T>({ kind: "transfer", key, ticket: entry.ticket, command });
  return (
    <TransferTaskControllerScope
      value={{
        id: item.id,
        pause: () => control({ operation: "pause" }),
        cancel: () => control({ operation: "cancel" }),
        clear: () => control({ operation: "clear" }),
        setSpeedLimit: (kib) => control<boolean>({ operation: "speedLimit", kib }),
        location: (location) => ({
          available: inspect.includes(location),
          open: () => control({ operation: "inspect", location }),
        }),
      }}
    >
      <TransferTask item={item} now={now} onResume={resume} />
      {prompt ? (
        <ConnectionPrompt
          key={prompt.handle}
          host={prompt.host}
          services={prompt.services}
          after="background"
          onConnected={() => {
            connected.current = true;
          }}
          onClose={() => {
            void close().catch((error) => toast(presentError(error), "error"));
          }}
        />
      ) : null}
    </TransferTaskControllerScope>
  );
}

function createPromptServices(
  send: <T>(command: TransferPromptOperation) => Promise<T>,
): ConnectionPromptServices {
  let preparation: Promise<TransferPromptPlan> | undefined;
  const prepare = () => (preparation ??= send<TransferPromptPlan>({ operation: "prepare" }));
  return {
    prepare,
    credentialStatus: async (id) => (await prepare()).saved[id] ?? false,
    probe: (credentials) => send({ operation: "probe", credentials }),
    trust: (fingerprint, credentials, expectedHostId) =>
      send({ operation: "trust", fingerprint, credentials, expectedHostId }),
    connect: (request) =>
      send({
        operation: "connect",
        password: request.password ?? null,
        passphrase: request.passphrase ?? null,
        credentials: request.jumpCredentials ?? {},
      }),
    test: (id, credentials) => send({ operation: "test", id, credentials }),
    cancelTest: (id) => send({ operation: "cancelTest", id }),
    credential: (hostId, password) => send({ operation: "credential", hostId, password }),
    installKey: (password, credentials) => send({ operation: "installKey", password, credentials }),
  };
}
