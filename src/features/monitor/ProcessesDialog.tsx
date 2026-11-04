import { ChevronLeft, ChevronRight, Pause, Play, RefreshCw, Search, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button, IconButton } from "@/components/ui/form/Button";
import { Input } from "@/components/ui/form/Field";
import { Dialog } from "@/components/ui/overlay/Dialog";
import { translateError } from "@/lib/api/errors";
import { formatBytes } from "@/lib/text/format";
import { api } from "@/lib/api/ipc";
import type { RemoteProcess } from "@/lib/api/types";
import type messages from "@/i18n/en-US.json";
import { useDialogs } from "@/store/dialogs";
import { useProcesses } from "./useProcesses";
import "./processes.css";

interface ProcessesDialogProps {
  sessionId: string;
  onClose: () => void;
}

type Column =
  | "name"
  | "pid"
  | "userName"
  | "cpuTotal"
  | "rss"
  | "diskReadRate"
  | "diskWriteRate"
  | "networkRxRate"
  | "networkTxRate"
  | "gpuPercent"
  | "gpuMemory";
type Label = keyof typeof messages.processes;
const columns: { key: Column; label: Label; hint?: Label }[] = [
  { key: "name", label: "name" },
  { key: "pid", label: "pid" },
  { key: "userName", label: "user" },
  { key: "cpuTotal", label: "cpu", hint: "cpuHint" },
  { key: "rss", label: "memory" },
  { key: "diskReadRate", label: "diskRead", hint: "diskHint" },
  { key: "diskWriteRate", label: "diskWrite", hint: "diskHint" },
  { key: "networkRxRate", label: "networkReceive", hint: "networkHint" },
  { key: "networkTxRate", label: "networkSend", hint: "networkHint" },
  { key: "gpuPercent", label: "gpu", hint: "gpuHint" },
  { key: "gpuMemory", label: "gpuMemory", hint: "gpuHint" },
];
const pageSize = 100;
const percent = (value: number) => `${value.toFixed(1)}%`;
const available = (value: number | undefined) =>
  value != null && Number.isFinite(value) && value >= 0;
const identity = (process: RemoteProcess) =>
  `${process.pid}:${process.startedAtTicks ?? "unknown"}`;

export function ProcessesDialog({ sessionId, onClose }: ProcessesDialogProps) {
  const { t, i18n } = useTranslation();
  const confirm = useDialogs((state) => state.confirm);
  const { items, error, loading, updatedAt, paused, refresh, togglePaused } =
    useProcesses(sessionId);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<{ key: Column; descending: boolean }>({
    key: "cpuTotal",
    descending: true,
  });
  const [page, setPage] = useState(0);
  const [selection, setSelection] = useState<{ sessionId: string; key: string } | null>(null);
  const [action, setAction] = useState<{
    sessionId: string;
    error: string | null;
    busy: boolean;
  } | null>(null);
  const owner = useRef(sessionId);
  const mounted = useRef(true);
  const epoch = useRef(0);
  useEffect(() => {
    epoch.current += 1;
    mounted.current = true;
    owner.current = sessionId;
    return () => {
      epoch.current += 1;
      mounted.current = false;
    };
  }, [sessionId]);
  // Dialog closure and server changes invalidate any pending confirmation.
  const close = () => {
    mounted.current = false;
    onClose();
  };

  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    const result = (items ?? []).filter(
      (process) =>
        !needle ||
        [
          process.name,
          process.pid,
          process.userName,
          process.groupName,
          process.uid,
          process.gid,
        ].some((value) =>
          String(value ?? "")
            .toLocaleLowerCase()
            .includes(needle),
        ),
    );
    return result.sort((left, right) => {
      const a = left[sort.key];
      const b = right[sort.key];
      if (a == null && b == null) return left.pid - right.pid;
      if (a == null) return 1;
      if (b == null) return -1;
      const difference =
        typeof a === "number" && typeof b === "number"
          ? a - b
          : String(a).localeCompare(String(b), i18n.resolvedLanguage, { numeric: true });
      return (sort.descending ? -difference : difference) || left.pid - right.pid;
    });
  }, [items, query, sort, i18n.resolvedLanguage]);
  const lastPage = Math.max(0, Math.ceil(filtered.length / pageSize) - 1);
  const currentPage = Math.min(page, lastPage);
  const selected =
    selection?.sessionId === sessionId
      ? items?.find((process) => identity(process) === selection.key)
      : undefined;
  const stopping = action?.sessionId === sessionId && action.busy;

  const kill = () => {
    if (!selected || stopping || selected.startedAtTicks == null) return;
    const process = selected;
    const requestEpoch = epoch.current;
    confirm({
      title: t("processes.killTitle"),
      body: t("processes.killBody", { name: process.name, pid: process.pid }),
      confirmLabel: t("processes.kill"),
      danger: true,
      onConfirm: async () => {
        if (!mounted.current || owner.current !== sessionId || epoch.current !== requestEpoch)
          return;
        setAction({ sessionId, busy: true, error: null });
        try {
          await api.remoteKill(sessionId, process.pid, process.startedAtTicks);
          if (mounted.current && owner.current === sessionId && epoch.current === requestEpoch)
            refresh();
        } catch (cause) {
          if (mounted.current && owner.current === sessionId && epoch.current === requestEpoch)
            setAction({ sessionId, busy: false, error: translateError(cause) });
          return;
        }
        if (mounted.current && owner.current === sessionId && epoch.current === requestEpoch)
          setAction({ sessionId, busy: false, error: null });
      },
    });
  };

  const cell = (process: RemoteProcess, key: Column) => {
    const value = process[key];
    if (key === "name" || key === "userName") return value ?? "—";
    if (!available(value as number | undefined)) return "—";
    if (key === "cpuTotal" || key === "gpuPercent") return percent(value as number);
    if (key === "rss" || key === "gpuMemory") return formatBytes(value as number);
    if (key === "pid") return value;
    return `${formatBytes(value as number)}/s`;
  };
  const details: [Label, string | number | undefined][] = selected
    ? [
        ["user", selected.userName],
        ["uid", selected.uid],
        ["group", selected.groupName],
        ["gid", selected.gid],
        ["parentPid", selected.parentPid],
        ["threads", selected.threads],
        ["state", selected.state],
        ["cpuPerCore", available(selected.cpuTotal) ? percent(selected.cpu) : undefined],
      ]
    : [];

  return (
    <Dialog
      open
      title={t("processes.title")}
      closeLabel={t("common.close")}
      onClose={close}
      width={1160}
      className="process-dialog"
      footer={
        <>
          <span className="process-status" role="status">
            {loading
              ? t("processes.updating")
              : paused
                ? t("processes.paused")
                : t("processes.live")}
            {updatedAt ? ` · ${new Date(updatedAt).toLocaleTimeString(i18n.resolvedLanguage)}` : ""}
          </span>
          <Button
            variant="ghost"
            leading={paused ? <Play size={13} /> : <Pause size={13} />}
            onClick={togglePaused}
          >
            {t(paused ? "processes.resume" : "processes.pause")}
          </Button>
          <Button
            variant="ghost"
            disabled={loading}
            leading={<RefreshCw size={13} />}
            onClick={refresh}
          >
            {t("processes.refresh")}
          </Button>
          <Button variant="secondary" onClick={close}>
            {t("common.close")}
          </Button>
        </>
      }
    >
      <div className="process-toolbar">
        <label className="process-search">
          <Search size={14} aria-hidden="true" />
          <Input
            aria-label={t("processes.search")}
            placeholder={t("processes.search")}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setPage(0);
            }}
          />
        </label>
        <span className="process-count">{t("processes.count", { count: filtered.length })}</span>
        <Button
          variant="ghost"
          leading={<Trash2 size={13} />}
          disabled={!selected || selected.pid <= 1 || selected.startedAtTicks == null || stopping}
          onClick={kill}
        >
          {t("processes.kill")}
        </Button>
      </div>
      {error || (action?.sessionId === sessionId && action.error) ? (
        <p className="connect__error" role="alert">
          {error || action?.error}
        </p>
      ) : null}
      <div className="process-scroll" tabIndex={0} aria-label={t("processes.title")}>
        <table className="process-grid" aria-label={t("processes.title")} aria-busy={loading}>
          <thead>
            <tr>
              {columns.map((column) => (
                <th
                  key={column.key}
                  scope="col"
                  aria-sort={
                    sort.key === column.key
                      ? sort.descending
                        ? "descending"
                        : "ascending"
                      : "none"
                  }
                >
                  <button
                    title={column.hint ? t(`processes.${column.hint}`) : undefined}
                    onClick={() => {
                      setSort({
                        key: column.key,
                        descending:
                          sort.key === column.key
                            ? !sort.descending
                            : column.key !== "name" && column.key !== "userName",
                      });
                      setPage(0);
                    }}
                  >
                    {t(`processes.${column.label}`)}
                    {sort.key === column.key ? (
                      <span aria-hidden="true">{sort.descending ? " ↓" : " ↑"}</span>
                    ) : null}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.slice(currentPage * pageSize, (currentPage + 1) * pageSize).map((process) => (
              <tr
                key={identity(process)}
                tabIndex={0}
                aria-selected={selected === process}
                onClick={() => setSelection({ sessionId, key: identity(process) })}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    setSelection({ sessionId, key: identity(process) });
                  }
                }}
              >
                {columns.map((column) => (
                  <td
                    key={column.key}
                    title={
                      column.key === "name"
                        ? process.name
                        : column.key === "userName"
                          ? `${process.userName ?? "—"} · ${process.groupName ?? "—"}`
                          : column.hint
                            ? t(`processes.${column.hint}`)
                            : undefined
                    }
                  >
                    {cell(process, column.key)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {!filtered.length ? (
          <p className="sftp-pane__empty">
            {t(items === null && !error ? "common.loading" : "processes.empty")}
          </p>
        ) : null}
      </div>
      <div className="process-pagination">
        <span>
          {t("processes.range", {
            from: filtered.length ? currentPage * pageSize + 1 : 0,
            to: Math.min((currentPage + 1) * pageSize, filtered.length),
            total: filtered.length,
          })}
        </span>
        <IconButton
          label={t("processes.previousPage")}
          size="sm"
          disabled={currentPage === 0}
          onClick={() => setPage(currentPage - 1)}
        >
          <ChevronLeft size={14} />
        </IconButton>
        <IconButton
          label={t("processes.nextPage")}
          size="sm"
          disabled={currentPage >= lastPage}
          onClick={() => setPage(currentPage + 1)}
        >
          <ChevronRight size={14} />
        </IconButton>
      </div>
      {selected ? (
        <section className="process-details" aria-label={t("processes.details")}>
          <strong title={selected.name}>
            {selected.name} <span>#{selected.pid}</span>
          </strong>
          <dl>
            {details.map(([key, value]) => (
              <div key={key}>
                <dt>{t(`processes.${key}`)}</dt>
                <dd>{value ?? "—"}</dd>
              </div>
            ))}
          </dl>
        </section>
      ) : null}
      <details className="process-help">
        <summary>{t("processes.metricsHelp")}</summary>
        <p>{t("processes.cpuHint")}</p>
        <p>{t("processes.diskHint")}</p>
        <p>{t("processes.networkHint")}</p>
        <p>{t("processes.gpuHint")}</p>
        <p>{t("processes.unavailableHint")}</p>
      </details>
    </Dialog>
  );
}
