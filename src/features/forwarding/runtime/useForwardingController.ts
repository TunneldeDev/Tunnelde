import { invoke } from "@tauri-apps/api/core";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { translateError } from "@/lib/api/errors";
import type { Host } from "@/lib/api/types";
import { useSsh } from "@/store/ssh";
import { useDialogs } from "@/store/dialogs";
import type { ForwardInfo, ForwardRule, RevisionedRule } from "../model/contract";
import { forwardingSavePayload, initialForwardRule } from "../model/payload";
import { forwardingStore, useForwardingSnapshot } from "../data/store";
import type { ForwardingAuthority } from "@/lib/extensions/forwarding/authority";
import type { FrontendForwardingEntry } from "@/lib/extensions/contracts/forwarding/entry";
import type { SshSession } from "@/lib/api/types";

type ConnectionRequest = { rules: readonly RevisionedRule[]; authority?: ForwardingAuthority };
const authorizedArgs = async (authority?: ForwardingAuthority) => {
  if (!authority) return {};
  const origin = await authority.origin();
  authority.authorize();
  return { origin };
};

/** One host owns its draft, delayed confirmations and independent SSH startup. */
export function useForwardingController(host: Host) {
  const { t } = useTranslation();
  const sessions = useSsh((state) => state.sessions);
  const session = sessions.find((item) => item.hostId === host.id && item.purpose === "forwarding");
  const [connectingRules, setConnectingRules] = useState<ConnectionRequest | null>(null);
  const snapshot = useForwardingSnapshot();
  const rules = useMemo(
    () => (snapshot.entries ?? []).filter((rule) => rule.hostId === host.id),
    [snapshot.entries, host.id],
  );
  const loading = snapshot.entries === null && snapshot.busy;
  const load = forwardingStore.refresh;
  const isActive = (rule: ForwardInfo) =>
    rule.active && sessions.some((item) => item.id === rule.sessionId);
  const [form, setForm] = useState<(ForwardRule & { revision?: string }) | null>(null);
  const [draftAuthority, setDraftAuthority] = useState<ForwardingAuthority>();
  const currentForm = useRef(form);
  useLayoutEffect(() => {
    currentForm.current = form;
  }, [form]);
  const [pending, setPending] = useState<string | null>(null);
  const [pendingKind, setPendingKind] = useState<"start" | "stop" | "save" | "remove">("start");
  const [operationFailure, setFailure] = useState<{ target: string; message: string } | null>(null);
  const mutation = useRef(false);
  const live = useRef(true);
  const confirm = useDialogs((state) => state.confirm);
  const failure =
    operationFailure ??
    (snapshot.error ? { target: "list", message: translateError(snapshot.error) } : null);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  const run = async (
    target: string,
    operation: () => Promise<unknown>,
    kind: typeof pendingKind = "start",
  ) => {
    if (mutation.current || !live.current) return false;
    mutation.current = true;
    setPending(target);
    setPendingKind(kind);
    setFailure(null);
    try {
      await operation();
      return true;
    } catch (cause) {
      if (live.current) setFailure({ target, message: translateError(cause) });
      return false;
    } finally {
      // Also reconcile partial failures; the shared store coalesces native events and completion.
      load();
      mutation.current = false;
      if (live.current) setPending(null);
    }
  };
  const startOnConnection = (
    targets: readonly RevisionedRule[],
    sessionId: string,
    authority?: ForwardingAuthority,
  ) => {
    void run(targets.length === 1 ? (targets[0]?.id ?? "group") : "group", async () => {
      const failures: string[] = [];
      for (const rule of targets) {
        try {
          if (!live.current) return;
          await invoke("forwarding_start", {
            id: rule.id,
            sessionId,
            expectedRevision: rule.revision,
            ...(await authorizedArgs(authority)),
          });
        } catch (cause) {
          if (targets.length === 1) throw cause;
          failures.push(`${rule.name}: ${translateError(cause)}`);
        }
      }
      if (failures.length) throw new Error(failures.join("; "));
    });
  };
  const startTargets = (targets: readonly RevisionedRule[], authority?: ForwardingAuthority) => {
    if (!targets.length || mutation.current || !live.current) return;
    authority?.authorize();
    const connected = useSsh
      .getState()
      .sessions.find((item) => item.hostId === host.id && item.purpose === "forwarding");
    if (!connected) {
      setConnectingRules({ rules: targets, authority });
      return;
    }
    startOnConnection(targets, connected.id, authority);
  };
  const start = (ids: string[]) => startTargets(rules.filter((rule) => ids.includes(rule.id)));
  const save = (rule: ForwardRule, start: boolean) => {
    if (mutation.current) return;
    const draft = form;
    if (!draft) return;
    const action = () =>
      run(
        "editor",
        async () => {
          if (currentForm.current !== draft || (draft.id && !draft.revision))
            throw new Error("forward.changed");
          const saved = await invoke<RevisionedRule>("forwarding_save", {
            ...(await authorizedArgs(draftAuthority)),
            rule: forwardingSavePayload(rule),
            ...(draft.id ? { expectedRevision: draft.revision } : {}),
          });
          forwardingStore.saved(saved);
          if (!live.current) return;
          setForm(null);
          if (start) {
            setPending(saved.id);
            setPendingKind("start");
            const connected = useSsh
              .getState()
              .sessions.find((item) => item.hostId === host.id && item.purpose === "forwarding");
            if (!connected) setConnectingRules({ rules: [saved], authority: draftAuthority });
            else {
              try {
                await invoke("forwarding_start", {
                  id: saved.id,
                  sessionId: connected.id,
                  expectedRevision: saved.revision,
                  ...(await authorizedArgs(draftAuthority)),
                });
              } catch (cause) {
                if (live.current) setFailure({ target: saved.id, message: translateError(cause) });
              }
            }
          }
        },
        "save",
      );
    if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(rule.bindHost.toLowerCase())) {
      confirm({
        title: t("forward.exposureTitle"),
        body: t("forward.exposureBody", { address: rule.bindHost }),
        confirmLabel: t(start ? "forward.saveStart" : "common.save"),
        danger: true,
        onConfirm: async () => {
          await action();
        },
      });
    } else void action();
  };
  const edit = (rule: ForwardInfo | FrontendForwardingEntry, authority?: ForwardingAuthority) => {
    authority?.authorize();
    setFailure(null);
    setDraftAuthority(authority);
    setForm({ ...rule });
  };
  const requestRemove = (rule: RevisionedRule, authority?: ForwardingAuthority) => {
    authority?.authorize();
    confirm({
      title: t("forward.deleteTitle"),
      body: t("forward.deleteBody", { name: rule.name }),
      confirmLabel: t("common.delete"),
      danger: true,
      onConfirm: async () => {
        await run(
          rule.id,
          async () =>
            invoke("forwarding_remove", {
              id: rule.id,
              expectedRevision: rule.revision,
              ...(await authorizedArgs(authority)),
            }),
          "remove",
        );
      },
    });
  };
  const stop = (rule: ForwardInfo | FrontendForwardingEntry, authority?: ForwardingAuthority) =>
    run(
      rule.id,
      async () =>
        invoke("forwarding_stop", {
          id: rule.id,
          ...(authority ? { expectedRevision: rule.revision, runtimeId: rule.runtimeId } : {}),
          ...(await authorizedArgs(authority)),
        }),
      "stop",
    );
  const requestDisconnect = (authority?: ForwardingAuthority) => {
    if (!session) return;
    authority?.authorize();
    confirm({
      title: t("forward.disconnectTitle"),
      body: t("forward.disconnectBody"),
      confirmLabel: t("terminal.disconnect"),
      onConfirm: async () => {
        await run(
          "group",
          async () => {
            if (
              !useSsh
                .getState()
                .sessions.some(
                  (item) =>
                    item.id === session.id &&
                    item.hostId === host.id &&
                    item.purpose === "forwarding",
                )
            )
              throw new Error("ssh.sessionMissing");
            if (authority) {
              await invoke("forwarding_provider_disconnect", {
                sessionId: session.id,
                ...(await authorizedArgs(authority)),
              });
              useSsh.getState().forget(session.id);
            } else await useSsh.getState().disconnect(session.id);
          },
          "stop",
        );
      },
    });
  };
  const busy = pending !== null;
  return {
    rules,
    sessions,
    validate: () =>
      forwardingStore.getSnapshot() === snapshot && useSsh.getState().sessions === sessions,
    loading,
    session,
    isActive,
    form,
    busy,
    failure,
    pending,
    pendingKind,
    connectingRules,
    start,
    save,
    startOnConnection,
    closeConnection: () => setConnectingRules(null),
    refresh: () => {
      setFailure(null);
      void load();
    },
    add: (authority?: ForwardingAuthority) => {
      authority?.authorize();
      setFailure(null);
      setDraftAuthority(authority);
      setForm(initialForwardRule(host.id));
    },
    edit,
    cancel: () => {
      setForm(null);
      setFailure(null);
    },
    stop,
    requestRemove,
    requestDisconnect,
    startTargets,
    /** Accept after authorization and before starting; undelivered sessions stay scope-owned. */
    connected: async (request: ConnectionRequest, connected: SshSession) => {
      if (!live.current) return;
      const authority = request.authority;
      if (authority) {
        const accepted = await run("group", async () => {
          await invoke("forwarding_provider_accept_connection", {
            sessionId: connected.id,
            ...(await authorizedArgs(authority)),
          });
          authority.authorize();
          useSsh.setState((state) => ({
            sessions: [...state.sessions.filter((item) => item.id !== connected.id), connected],
          }));
        });
        // Failed acceptance may have reported an error and must not start any rule.
        if (!accepted) return;
      }
      startOnConnection(request.rules, connected.id, authority);
    },
  };
}

export type ForwardingController = ReturnType<typeof useForwardingController>;
