import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "@/lib/api/ipc";
import { presentError } from "@/lib/api/errors";
import type { RemoteProcess } from "@/lib/api/types";
import type { FrontendProcessSort } from "@/lib/extensions/contracts/monitor/processes/query";
import { useDialogs } from "@/store/dialogs";
import { useWorkspace } from "@/store/workspace";
import { useSsh } from "@/store/ssh";
import { useProcesses } from "../../useProcesses";
import { queryProcesses } from "../data/query";
import { processIdentity } from "@/lib/monitor/processes/model";
import { readProcessSample } from "./sampling";

export function useProcessManager(sessionId: string, active = true) {
  const { t, i18n } = useTranslation();
  const sample = useProcesses(sessionId, active);
  const [query, setQueryState] = useState("");
  const [sort, setSortState] = useState<FrontendProcessSort>({ key: "cpuTotal", descending: true });
  const [page, setPage] = useState(0);
  const [pageSize, setPageSizeState] = useState(100);
  const [selection, setSelection] = useState<{ sessionId: string; key: string } | null>(null);
  const [action, setAction] = useState<{
    sessionId: string;
    error: string | null;
    busy: boolean;
  } | null>(null);
  const current = useRef<{ sessionId: string; items: typeof sample.items; epoch: object } | null>(
    null,
  );
  const epoch = useMemo(() => ({ sessionId }), [sessionId]);
  const closed = useRef<object | null>(null);
  const lock = useRef<object | null>(null);
  const confirmation = useRef<object | null>(null);
  useLayoutEffect(() => {
    current.current = { sessionId, items: sample.items, epoch };
    return () => {
      current.current = null;
    };
  }, [sessionId, sample.items, epoch]);
  const live = () =>
    closed.current !== epoch &&
    current.current?.epoch === epoch &&
    useSsh.getState().sessions.some((session) => session.id === sessionId) &&
    !useSsh.getState().disconnectingSessionIds.includes(sessionId);
  const filtered = useMemo(
    () => queryProcesses(sample.items ?? [], query, sort, i18n.resolvedLanguage),
    [sample.items, query, sort, i18n.resolvedLanguage],
  );
  const lastPage = Math.max(0, Math.ceil(filtered.length / pageSize) - 1);
  const selected =
    selection?.sessionId === sessionId
      ? sample.items?.find((item) => processIdentity(item) === selection.key)
      : undefined;
  const requestTerminate = (
    process: RemoteProcess,
    authorize: () => void = () => {},
    tree = false,
  ) => {
    const present = () =>
      live() &&
      readProcessSample(sessionId).items?.some(
        (item) => processIdentity(item) === processIdentity(process),
      );
    if (
      !present() ||
      lock.current ||
      !Number.isSafeInteger(process.pid) ||
      process.pid <= 1 ||
      !Number.isSafeInteger(process.startedAtTicks) ||
      process.startedAtTicks! < 0
    )
      return;
    authorize();
    const request = {};
    confirmation.current = request;
    let consumed = false;
    useDialogs.getState().confirm({
      title: t(tree ? "processes.killTree" : "processes.killTitle"),
      body: t(tree ? "processes.killTreeBody" : "processes.killBody", {
        name: process.name,
        pid: process.pid,
      }),
      confirmLabel: t(tree ? "processes.killTree" : "processes.kill"),
      danger: true,
      onConfirm: async () => {
        if (consumed || confirmation.current !== request || lock.current || !present()) return;
        consumed = true;
        lock.current = request;
        setAction({ sessionId, busy: true, error: null });
        try {
          authorize();
          // Authorization may synchronously retire this view or connection.
          if (!present()) return;
          if (tree) await api.remoteKillTree(sessionId, process.pid, process.startedAtTicks!);
          else await api.remoteKill(sessionId, process.pid, process.startedAtTicks);
          if (live()) {
            sample.refresh();
            setAction({ sessionId, busy: false, error: null });
          }
        } catch (cause) {
          if (live())
            setAction({
              sessionId,
              busy: false,
              error: presentError(
                cause instanceof Error && cause.message === "plugin.frontend.viewUnavailable"
                  ? new Error("plugin.processes.providerInactive")
                  : cause,
              ),
            });
        } finally {
          if (lock.current === request) lock.current = null;
        }
      },
    });
  };
  return {
    ...sample,
    sessionId,
    query,
    sort,
    filtered,
    selected,
    page,
    setPage,
    lastPage,
    pageSize,
    setPageSize(value: number) {
      if (![25, 50, 100, 200].includes(value)) return;
      setPage(Math.floor((Math.min(page, lastPage) * pageSize) / value));
      setPageSizeState(value);
    },
    currentPage: Math.min(page, lastPage),
    stopping: action?.sessionId === sessionId && action.busy,
    error: sample.error || (action?.sessionId === sessionId ? action.error : null),
    setQuery(value: string) {
      setQueryState(value);
      setPage(0);
    },
    setSort(value: FrontendProcessSort) {
      setSortState(value);
      setPage(0);
    },
    select(process: RemoteProcess | null) {
      setSelection(process ? { sessionId, key: processIdentity(process) } : null);
    },
    requestTerminate,
    async openLocation(process: RemoteProcess) {
      const present = () =>
        live() &&
        readProcessSample(sessionId).items?.some(
          (item) => processIdentity(item) === processIdentity(process),
        );
      if (!present() || process.startedAtTicks == null || lock.current) return;
      const request = {};
      lock.current = request;
      setAction({ sessionId, busy: true, error: null });
      try {
        const executable = await api.remoteProcessExecutable(
          sessionId,
          process.pid,
          process.startedAtTicks,
        );
        if (!present()) return;
        const session = useSsh.getState().sessions.find((item) => item.id === sessionId)!;
        useWorkspace
          .getState()
          .openFilePane(
            {
              source: { kind: "remote", sessionId },
              path: executable.slice(0, executable.lastIndexOf("/")) || "/",
              ownerSessionId: sessionId,
              remoteIdentity: { hostId: session.hostId, address: session.address },
            },
            process.name,
          );
        setAction({ sessionId, busy: false, error: null });
      } catch (cause) {
        if (live()) setAction({ sessionId, busy: false, error: presentError(cause) });
      } finally {
        if (lock.current === request) lock.current = null;
      }
    },
    validate: () => live() && readProcessSample(sessionId).items === sample.items,
    close() {
      closed.current = epoch;
      current.current = null;
      confirmation.current = null;
    },
  };
}
export type ProcessManager = ReturnType<typeof useProcessManager>;
