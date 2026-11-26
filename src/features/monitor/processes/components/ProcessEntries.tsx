import { ChevronsLeft, ChevronsRight, ChevronLeft, ChevronRight, Trash2 } from "lucide-react";
import { useState } from "react";
import { Select } from "@/components/ui/form/Select";
import { useTranslation } from "react-i18next";
import { Button, IconButton } from "@/components/ui/form/Button";
import { SearchToolbar } from "@/components/ui/layout/SearchToolbar";
import { formatBytes } from "@/lib/text/format";
import type { RemoteProcess } from "@/lib/api/types";
import type { FrontendProcessColumn } from "@/lib/extensions/contracts/monitor/processes/query";
import type messages from "@/i18n/en-US.json";
import { processIdentity as identity } from "@/lib/monitor/processes/model";
import type { ProcessManager } from "../runtime/useManager";
type Label = keyof typeof messages.processes;
const columns: { key: FrontendProcessColumn; label: Label; hint?: Label }[] = [
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
const percent = (value: number) => `${value.toFixed(1)}%`;
const available = (value: number | undefined) =>
  value != null && Number.isFinite(value) && value >= 0;

export function ProcessEntries({ manager }: { manager: ProcessManager }) {
  const { t } = useTranslation();
  const {
    query,
    setQuery,
    sort,
    setSort,
    pageSize,
    setPageSize,
    currentPage,
    lastPage,
    setPage,
    filtered,
    selected,
    select,
    stopping,
    items,
    error,
    loading,
    requestTerminate,
  } = manager;
  const [jump, setJump] = useState("");
  const kill = () => {
    if (selected) requestTerminate(selected);
  };
  const cell = (process: RemoteProcess, key: FrontendProcessColumn) => {
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
    <>
      <SearchToolbar
        className="process-toolbar"
        aria-label={t("processes.search")}
        placeholder={t("processes.search")}
        value={query}
        presets={[
          { key: "name", value: "", label: t("searchUi.name") },
          { key: "pid", value: "", label: t("searchUi.pid") },
          { key: "user", value: "", label: t("searchUi.user") },
          { key: "group", value: "", label: t("searchUi.group") },
          { key: "cpu", value: ">10", label: t("searchUi.cpu") },
          { key: "memory", value: ">100MB", label: t("searchUi.memory") },
        ]}
        onChange={(value) => {
          setQuery(value);
          setPage(0);
        }}
        status={t("processes.count", { count: filtered.length })}
        actions={
          <Button
            variant="ghost"
            leading={<Trash2 size={13} />}
            disabled={!selected || selected.pid <= 1 || selected.startedAtTicks == null || stopping}
            onClick={kill}
          >
            {t("processes.kill")}
          </Button>
        }
      />
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
                onClick={() => select(process)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    select(process);
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
        <Select
          label={t("processes.pageSize")}
          value={String(pageSize)}
          options={[25, 50, 100, 200].map((size) => ({
            value: String(size),
            label: t("processes.perPage", { count: size }),
          }))}
          onChange={(value) => setPageSize(Number(value))}
        />
        <IconButton
          label={t("processes.firstPage")}
          size="sm"
          disabled={currentPage === 0}
          onClick={() => setPage(0)}
        >
          <ChevronsLeft size={14} />
        </IconButton>
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
        <IconButton
          label={t("processes.lastPage")}
          size="sm"
          disabled={currentPage >= lastPage}
          onClick={() => setPage(lastPage)}
        >
          <ChevronsRight size={14} />
        </IconButton>
        <span aria-live="polite">
          {t("processes.pageNumber", { page: currentPage + 1, total: lastPage + 1 })}
        </span>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const value = Number(jump);
            if (Number.isInteger(value) && value >= 1 && value <= lastPage + 1) {
              setPage(value - 1);
              setJump("");
            }
          }}
        >
          <input
            className="td-input"
            aria-label={t("processes.jumpPage")}
            type="number"
            min={1}
            max={lastPage + 1}
            value={jump}
            onChange={(event) => setJump(event.target.value)}
          />
          <Button size="sm" type="submit" disabled={!jump}>
            {t("processes.go")}
          </Button>
        </form>
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
    </>
  );
}
