import { useSsh } from "@/store/ssh";
import { forwardingGroupsStore, useForwardingGroupsSnapshot } from "../data/groups";
import { useForwardingCaptureGuard } from "./useForwardingCaptureGuard";
import { usePanelViewState } from "@/lib/panels/viewState";
import { forwardDraft, type ForwardDraft } from "../model/viewState";
import { useForwardingActions } from "./actionScope";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { translateError } from "@/lib/api/errors";
import { isIpcError, type Host, type SshConnectRequest } from "@/lib/api/types";
import type { ConnectionReview } from "@/lib/api/connections/review";
import { useForwardingReadModel, useForwardingSessions } from "../data/readScope";
import { useDialogs } from "@/store/dialogs";
import type { ForwardInfo, ForwardRule, RevisionedRule } from "../model/contract";
import { forwardingSavePayload, initialForwardRule } from "../model/payload";
import { forwardingStore, useForwardingSnapshot } from "../data/store";
import type { ForwardingAuthority } from "@/lib/extensions/forwarding/authority";
import type { FrontendForwardingEntry } from "@/lib/extensions/contracts/forwarding/entry";
import type { SshSession } from "@/lib/api/types";

type ConnectionRequest = { rules: readonly RevisionedRule[]; authority?: ForwardingAuthority };
/** One host owns its draft, delayed confirmations and independent SSH startup. */
export function useForwardingController(host: Host) {
  const { t } = useTranslation();
  const actions = useForwardingActions();
  const remoteData = useForwardingReadModel();
  const sessions = useForwardingSessions();
  const session = sessions.find((item) => item.hostId === host.id && item.purpose === "forwarding");
  const [connectingRules, setConnectingRules] = useState<ConnectionRequest | null>(null);
  const snapshot = useForwardingSnapshot();
  const rules = useMemo(
    () => (snapshot.entries ?? []).filter((rule) => rule.hostId === host.id),
    [snapshot.entries, host.id],
  );
  const groupSnapshot = useForwardingGroupsSnapshot();
  const groups = useMemo(
    () => (groupSnapshot.entries ?? []).filter((group) => group.hostId === host.id),
    [groupSnapshot.entries, host.id],
  );
  const currentData = useRef({ snapshot, groupSnapshot, sessions });
  useLayoutEffect(() => {
    currentData.current = { snapshot, groupSnapshot, sessions };
  }, [snapshot, groupSnapshot, sessions]);
  const groupError = groupSnapshot.error ? translateError(groupSnapshot.error) : null;
  const loading =
    (snapshot.entries === null && snapshot.busy) ||
    (groupSnapshot.entries === null && groupSnapshot.busy);
  const load = actions.refresh;
  const isActive = (rule: ForwardInfo) =>
    rule.active && sessions.some((item) => item.id === rule.sessionId);
  const [form, setForm] = usePanelViewState<ForwardDraft | null>(
    "rule-editor",
    null,
    (value): value is ForwardDraft | null => forwardDraft(value, host.id),
  );
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
  useForwardingCaptureGuard(
    "controller-admission",
    () =>
      mutation.current ||
      !!connectingRules ||
      (!!form && !!draftAuthority) ||
      useDialogs.getState().dialog.kind === "confirm",
  );
  const failure =
    operationFailure ??
    (groupError ? { target: "list", message: groupError } : null) ??
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
  const startOne = (
    rule: RevisionedRule,
    authority?: ForwardingAuthority,
    request?: SshConnectRequest,
    review?: ConnectionReview,
  ) => actions.start(rule, authority, request, review);
  const startTargets = (targets: readonly RevisionedRule[], authority?: ForwardingAuthority) => {
    if (!targets.length || mutation.current || !live.current) return;
    authority?.authorize();
    void run(targets.length === 1 ? targets[0]!.id : "group", async () => {
      const failures: string[] = [];
      for (let index = 0; index < targets.length; index++) {
        if (!live.current) return;
        const rule = targets[index]!;
        setPending(rule.id);
        try {
          await startOne(rule, authority);
        } catch (cause) {
          const message = isIpcError(cause) ? cause.message : String(cause);
          if (
            /ssh\.(passwordRequired|passphraseRequired|authFailed|authenticationFailed|hostKeyUntrusted|hostKeyChanged|keyPassphraseRequired|keyAuthFailed|keyLoad|agentUnavailable)/.test(
              message,
            )
          ) {
            setConnectingRules({ rules: targets.slice(index), authority });
            break;
          }
          failures.push(`${rule.name}: ${translateError(cause)}`);
        }
      }
      if (failures.length) throw new Error(failures.join("; "));
    });
  };
  const start = (ids: string[]) => startTargets(rules.filter((rule) => ids.includes(rule.id)));
  const canStart = (rule: ForwardInfo) =>
    !isActive(rule) &&
    rule.automationStatus?.phase !== "starting" &&
    rule.automationStatus?.phase !== "retrying";
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
          const saved = await actions.save(
            rule,
            draft.id ? draft.revision : undefined,
            draftAuthority,
          );
          if (!live.current) return;
          setForm(null);
          if (start) {
            setPending(saved.id);
            setPendingKind("start");
            try {
              await startOne(saved, draftAuthority);
            } catch (cause) {
              const message = isIpcError(cause) ? cause.message : String(cause);
              if (
                /ssh\.(passwordRequired|passphraseRequired|authFailed|authenticationFailed|hostKeyUntrusted|hostKeyChanged|keyPassphraseRequired|keyAuthFailed|keyLoad|agentUnavailable)/.test(
                  message,
                )
              )
                setConnectingRules({ rules: [saved], authority: draftAuthority });
              else if (live.current)
                setFailure({ target: saved.id, message: translateError(cause) });
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
    const native = rules.find((entry) => entry.id === rule.id && entry.revision === rule.revision);
    setForm({
      ...forwardingSavePayload(rule),
      revision: rule.revision,
      groupId: native?.groupId ?? null,
      ...(native?.automation ? { automation: native.automation } : {}),
    });
  };
  const requestRemove = (rule: RevisionedRule, authority?: ForwardingAuthority) => {
    authority?.authorize();
    confirm({
      title: t("forward.deleteTitle"),
      body: t("forward.deleteBody", { name: rule.name }),
      confirmLabel: t("common.delete"),
      danger: true,
      onConfirm: async () => {
        await run(rule.id, () => actions.remove(rule, authority), "remove");
      },
    });
  };
  const stop = (rule: ForwardInfo | FrontendForwardingEntry, authority?: ForwardingAuthority) =>
    run(rule.id, () => actions.stop(rule, authority), "stop");
  const requestDisconnect = (authority?: ForwardingAuthority) => {
    authority?.authorize();
    const targets = sessions.filter(
      (item) => item.hostId === host.id && item.purpose === "forwarding",
    );
    if (!targets.length) return;
    confirm({
      title: t("forward.disconnectTitle"),
      body: t("forward.disconnectBody", { count: targets.length, host: host.name }),
      confirmLabel: t("terminal.disconnect"),
      onConfirm: async () => {
        await run(
          "group",
          async () => {
            const failures: string[] = [];
            for (const item of targets) {
              try {
                await actions.disconnect(host.id, item.id, authority);
              } catch (cause) {
                failures.push(translateError(cause));
              }
            }
            if (failures.length) throw new Error(failures.join("; "));
          },
          "stop",
        );
      },
    });
  };
  const busy = pending !== null;
  return {
    actions,
    rules,
    groups,
    sessions,
    validate: () =>
      currentData.current.snapshot === snapshot &&
      currentData.current.groupSnapshot === groupSnapshot &&
      currentData.current.sessions === sessions &&
      (remoteData !== null ||
        (forwardingStore.getSnapshot() === snapshot &&
          forwardingGroupsStore.getSnapshot() === groupSnapshot &&
          useSsh.getState().sessions === sessions)),
    loading,
    session,
    isActive,
    canStart,
    form,
    busy,
    failure,
    pending,
    pendingKind,
    connectingRules,
    start,
    save,
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
    connectAndStart: async (
      connection: ConnectionRequest,
      request: SshConnectRequest,
      review?: ConnectionReview,
    ) => {
      const first = connection.rules[0];
      if (!first) throw new Error("forward.missing");
      const connected = await startOne(first, connection.authority, request, review);
      const failures: string[] = [];
      for (const rule of connection.rules.slice(1)) {
        if (!live.current) break;
        try {
          await startOne(rule, connection.authority, request, review);
        } catch (cause) {
          failures.push(`${rule.name}: ${translateError(cause)}`);
        }
      }
      if (failures.length && live.current)
        setFailure({ target: "group", message: failures.join("; ") });
      void load();
      return connected;
    },
    connected: async (_request: ConnectionRequest, _connected: SshSession) => {
      void load();
    },
  };
}

export type ForwardingController = ReturnType<typeof useForwardingController>;
