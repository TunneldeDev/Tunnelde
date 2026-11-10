import { invoke } from "@tauri-apps/api/core";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { translateError } from "@/lib/api/errors";
import type { Host } from "@/lib/api/types";
import { useSsh } from "@/store/ssh";
import { useDialogs } from "@/store/dialogs";
import type { ForwardInfo, ForwardRule, RevisionedRule } from "../model/contract";
import { forwardingSavePayload, initialForwardRule } from "../model/payload";
import { forwardingStore, useForwardingSnapshot } from "../data/store";

/** One host owns its draft, delayed confirmations and independent SSH startup. */
export function useForwardingController(host: Host) {
  const { t } = useTranslation();
  const sessions = useSsh((state) => state.sessions);
  const session = sessions.find((item) => item.hostId === host.id && item.purpose === "forwarding");
  const [connectingRules, setConnectingRules] = useState<RevisionedRule[] | null>(null);
  const snapshot = useForwardingSnapshot();
  const rules = (snapshot.entries ?? []).filter((rule) => rule.hostId === host.id);
  const loading = snapshot.entries === null && snapshot.busy;
  const load = forwardingStore.refresh;
  const isActive = (rule: ForwardInfo) =>
    rule.active && sessions.some((item) => item.id === rule.sessionId);
  const [form, setForm] = useState<(ForwardRule & { revision?: string }) | null>(null);
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
    if (mutation.current || !live.current) return;
    mutation.current = true;
    setPending(target);
    setPendingKind(kind);
    setFailure(null);
    try {
      await operation();
    } catch (cause) {
      if (live.current) setFailure({ target, message: translateError(cause) });
    } finally {
      // Also reconcile partial failures; the shared store coalesces native events and completion.
      load();
      mutation.current = false;
      if (live.current) setPending(null);
    }
  };
  const startOnConnection = (targets: RevisionedRule[], sessionId: string) => {
    void run(targets.length === 1 ? (targets[0]?.id ?? "group") : "group", async () => {
      const failures: string[] = [];
      for (const rule of targets) {
        try {
          if (!live.current) return;
          await invoke("forwarding_start", {
            id: rule.id,
            sessionId,
            expectedRevision: rule.revision,
          });
        } catch (cause) {
          if (targets.length === 1) throw cause;
          failures.push(`${rule.name}: ${translateError(cause)}`);
        }
      }
      if (failures.length) throw new Error(failures.join("; "));
    });
  };
  const start = (ids: string[]) => {
    const targets = rules.filter((rule) => ids.includes(rule.id));
    const connected = useSsh
      .getState()
      .sessions.find((item) => item.hostId === host.id && item.purpose === "forwarding");
    if (!connected) {
      setConnectingRules(targets);
      return;
    }
    startOnConnection(targets, connected.id);
  };
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
            if (!connected) setConnectingRules([saved]);
            else {
              try {
                await invoke("forwarding_start", {
                  id: saved.id,
                  sessionId: connected.id,
                  expectedRevision: saved.revision,
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
        onConfirm: action,
      });
    } else void action();
  };
  const busy = pending !== null;
  return {
    rules,
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
    add: () => {
      setFailure(null);
      setForm(initialForwardRule(host.id));
    },
    edit: (rule: ForwardInfo) => {
      setFailure(null);
      setForm({ ...rule });
    },
    cancel: () => {
      setForm(null);
      setFailure(null);
    },
    stop: (rule: ForwardInfo) =>
      run(rule.id, () => invoke("forwarding_stop", { id: rule.id }), "stop"),
    requestRemove: (rule: ForwardInfo) =>
      confirm({
        title: t("forward.deleteTitle"),
        body: t("forward.deleteBody", { name: rule.name }),
        confirmLabel: t("common.delete"),
        danger: true,
        onConfirm: () =>
          run(
            rule.id,
            () => invoke("forwarding_remove", { id: rule.id, expectedRevision: rule.revision }),
            "remove",
          ),
      }),
    requestDisconnect: () => {
      if (!session) return;
      confirm({
        title: t("forward.disconnectTitle"),
        body: t("forward.disconnectBody"),
        confirmLabel: t("terminal.disconnect"),
        onConfirm: () => useSsh.getState().disconnect(session.id),
      });
    },
  };
}

export type ForwardingController = ReturnType<typeof useForwardingController>;
