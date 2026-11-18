import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { FolderOpen, Pencil, Play, Plus, RotateCw, Square, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/form/Button";
import { Field, Input } from "@/components/ui/form/Field";
import { Select } from "@/components/ui/form/Select";
import { translateError } from "@/lib/api/errors";
import { nativeEvents } from "@/lib/events/native";
import type {
  MountEntry,
  MountGroup,
  MountRule,
} from "@/lib/extensions/contracts/mounts/configuration";
import type { MountOperation, MountSnapshot } from "@/lib/extensions/contracts/mounts/runtime";
import { useDialogs } from "@/store/dialogs";
import { useHosts } from "@/store/hosts";
import { usePlugins } from "@/store/plugins";
import { usePluginSecurity } from "@/store/pluginSecurity";
import "@/styles/sharedMounts.css";

interface Surface {
  pluginId: string;
  viewId: string;
  contributionId?: string;
  hostId?: string;
  visible?: boolean;
}
type Call = <T>(method: string, params?: object) => Promise<T>;
type Draft =
  { type: "group"; entry: MountEntry<MountGroup> } | { type: "rule"; entry: MountEntry<MountRule> };
interface LegacyMount {
  mount: { id: string; remotePath: string; mountPoint: string };
}
const active = (operation: MountOperation) => ["pending", "running"].includes(operation.phase);

function useMountActions() {
  const pending = useRef(false);
  const refresh = useRef<() => void>(() => {});
  const setRefresh = useCallback((read: () => void) => { refresh.current = read; }, []);
  const requestRefresh = useCallback(() => refresh.current(), []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const run = useCallback(async (action: () => Promise<unknown>) => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (cause) {
      setError(translateError(cause));
    } finally {
      pending.current = false;
      setBusy(false);
      requestRefresh();
    }
  }, [requestRefresh]);
  return { busy, error, setError, setRefresh, requestRefresh, run };
}

export function SharedMounts({
  pluginId,
  viewId,
  contributionId,
  hostId,
  visible = true,
}: Surface) {
  const { t } = useTranslation();
  const runtimeId = usePlugins(
    (s) => s.items.find((p) => p.id === pluginId && p.status === "running")?.runtimeId,
  );
  const restricted = usePluginSecurity((s) => s.state.restricted);
  const permissions = usePluginSecurity((s) => s.state.grants[pluginId]);
  const hosts = useHosts((s) => s.hosts);
  const saved = hosts.filter((h) => !h.source);
  const [selected, select] = useState("");
  const current = hostId ?? (saved.some((h) => h.id === selected) ? selected : saved[0]?.id);
  const call: Call = useCallback(
    (method, params = {}) =>
      invoke("plugin_shared_mounts_action", {
        surface: { pluginId, runtimeId, viewId, contributionId },
        method,
        params,
      }),
    [pluginId, runtimeId, viewId, contributionId],
  );
  if (
    restricted ||
    !runtimeId ||
    !["hosts.read", "mounts.read", ...(contributionId ? ["mounts.hostDetails"] : [])].every((p) =>
      permissions?.includes(p),
    )
  ) {
    return <p role="status">{t("mounts.shared.unavailable")}</p>;
  }
  return (
    <div className="shared-mounts">
      {!hostId && saved.length > 0 && (
        <Field label={t("mounts.shared.host")}>
          <Select
            value={current ?? ""}
            label={t("mounts.shared.host")}
            options={saved.map((h) => ({ value: h.id, label: h.name }))}
            onChange={select}
          />
        </Field>
      )}
      {current ? (
        <MountPanel
          key={`${runtimeId}:${current}`}
          hostId={current}
          call={call}
          visible={visible}
          write={permissions?.includes("mounts.write") ?? false}
        />
      ) : (
        <p role="status">{t("mounts.shared.noHosts")}</p>
      )}
    </div>
  );
}

function MountPanel({
  hostId,
  call,
  write,
  visible,
}: {
  hostId: string;
  call: Call;
  write: boolean;
  visible: boolean;
}) {
  const { t } = useTranslation();
  const [snapshot, setSnapshot] = useState<MountSnapshot>();
  const [operation, setOperation] = useState<MountOperation>();
  const [draft, setDraft] = useState<Draft>();
  const [legacy, setLegacy] = useState<LegacyMount[]>([]);
  const [dependency, setDependency] = useState<boolean>();
  const { busy, error, setError, setRefresh, requestRefresh, run } = useMountActions();
  const [time, setTime] = useState(Date.now);
  const operationId = operation && active(operation) ? operation.id : undefined;

  useEffect(() => {
    if (!visible) return;
    const controller = new AbortController();
    let reading = false;
    let dirty = false;
    const read = async () => {
      dirty = true;
      if (reading || controller.signal.aborted) return;
      reading = true;
      try {
        while (dirty && !controller.signal.aborted) {
          dirty = false;
          const [next, old, progress] = await Promise.all([
            call<MountSnapshot>("mounts.rules.snapshot", { hostId }),
            call<{ items: LegacyMount[] }>("mounts.legacy.list", { hostId }),
            operationId
              ? call<MountOperation>("mounts.operations.get", { id: operationId })
              : undefined,
          ]);
          if (controller.signal.aborted) return;
          setSnapshot(next);
          setLegacy(old.items);
          if (progress) setOperation(progress);
        }
      } catch (cause) {
        if (!controller.signal.aborted) setError(translateError(cause));
      } finally {
        reading = false;
      }
    };
    setRefresh(() => void read());
    void Promise.all([
      nativeEvents.on("mounts://changed", () => void read(), controller.signal),
      nativeEvents.on(
        "mounts://operation-changed",
        ({ id }) => {
          if (id === operationId) void read();
        },
        controller.signal,
      ),
    ]).then(read, (cause: unknown) => {
      if (!controller.signal.aborted) setError(translateError(cause));
      void read();
    });
    void call<{ available: boolean }>("mounts.dependencies.get").then(
      (result) => {
        if (!controller.signal.aborted) setDependency(result.available);
      },
      (cause: unknown) => {
        if (!controller.signal.aborted) setError(translateError(cause));
      },
    );
    return () => {
      controller.abort();
      setRefresh(() => {});
    };
  }, [call, hostId, operationId, visible, setRefresh, setError]);

  const retrying = snapshot?.connections.some((c) => c.phase === "retrying") ?? false;
  useEffect(() => {
    if (!retrying || !visible) return;
    const timer = setInterval(() => setTime(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [retrying, visible]);

  const mutate = (method: string, params: object = {}, receipt = true) =>
    void run(async () => {
      if (receipt) setOperation(await call<MountOperation>(method, params));
      else await call(method, params);
    });
  const confirm = (
    key: `mounts.shared.${"removeRule" | "removeGroup" | "migrate"}`,
    action: () => void,
    danger = false,
  ) =>
    useDialogs.getState().confirm({
      title: t(key),
      body: t(`${key}Confirm`),
      confirmLabel: t(key),
      danger,
      onConfirm: action,
    });
  const save = () =>
    draft &&
    void run(async () => {
      const { type, entry } = draft;
      const collection = type === "group" ? "groups" : "rules";
      await call(`mounts.${collection}.save`, {
        [type]: entry.value,
        expectedRevision: entry.revision || undefined,
      });
      setDraft(undefined);
    });
  const locked = busy || !!operationId;
  const phase = (value: string) => t(`mounts.shared.phase.${value}`, value);
  const icon = (
    key: `mounts.shared.${"reconnect" | "editGroup" | "removeGroup" | "start" | "stop" | "retry" | "open" | "editRule" | "removeRule"}`,
    glyph: React.ReactNode,
    onClick: () => void,
    disabled = locked,
  ) => (
    <Button
      variant="ghost"
      size="sm"
      title={t(key)}
      aria-label={t(key)}
      disabled={disabled}
      onClick={onClick}
    >
      {glyph}
    </Button>
  );
  return (
    <div className="shared-mounts" aria-busy={!snapshot && !error}>
      {!snapshot && !error && <p role="status">{t("common.loading")}</p>}
      {error && (
        <p role="alert" className="panel__error">
          {error}{" "}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setError("");
              requestRefresh();
            }}
          >
            {t("mounts.shared.refresh")}
          </Button>
        </p>
      )}
      {dependency === false && (
        <p role="status">
          {t("mounts.shared.dependencies")}{" "}
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => mutate("mounts.dependencies.documentation", {}, false)}
          >
            {t("mounts.shared.guide")}
          </Button>
        </p>
      )}
      {snapshot && (
        <>
          {write && (
            <div className="shared-mounts__actions">
              <Button
                size="sm"
                leading={<Plus size={14} />}
                disabled={locked}
                onClick={() =>
                  setDraft({
                    type: "group",
                    entry: {
                      revision: "",
                      value: { id: crypto.randomUUID(), hostId, name: "", autoReconnect: false },
                    },
                  })
                }
              >
                {t("mounts.shared.newGroup")}
              </Button>
              <Button
                size="sm"
                variant="secondary"
                disabled={locked || !snapshot.rules.length}
                onClick={() => mutate("mounts.runtime.startAll", { hostId })}
              >
                {t("mounts.shared.startAll")}
              </Button>
              <Button
                size="sm"
                variant="secondary"
                disabled={locked || !snapshot.rules.length}
                onClick={() => mutate("mounts.runtime.stopAll", { hostId })}
              >
                {t("mounts.shared.stopAll")}
              </Button>
            </div>
          )}
          {!snapshot.groups.length && <p>{t("mounts.shared.noGroups")}</p>}
          {snapshot.groups.map((entry) => {
            const group = entry.value;
            const params = { id: group.id, expectedRevision: entry.revision };
            const status = snapshot.connections.find((c) => c.groupId === group.id);
            const disconnected = !status || status.phase === "disconnected";
            const rules = snapshot.rules.filter((r) => r.value.groupId === group.id);
            return (
              <section className="shared-mounts__group" key={group.id} aria-label={group.name}>
                <div className="shared-mounts__row">
                  <div>
                    <strong>{group.name}</strong>{" "}
                    <span role="status">
                      {phase(status?.phase ?? "disconnected")}
                      {status?.phase === "retrying" && status.retryAt != null
                        ? ` (${Math.max(0, Math.ceil((status.retryAt - time) / 1000))}s)`
                        : ""}
                    </span>
                    {status?.error && (
                      <div className="panel__error">{translateError(status.error.message)}</div>
                    )}
                  </div>
                  {write && (
                    <div className="shared-mounts__actions">
                      {disconnected ? (
                        <Button
                          variant="secondary"
                          size="sm"
                          disabled={locked}
                          onClick={() => mutate("mounts.groups.connect", params)}
                        >
                          {t("mounts.shared.connect")}
                        </Button>
                      ) : (
                        <Button
                          variant="secondary"
                          size="sm"
                          disabled={locked}
                          onClick={() => mutate("mounts.groups.disconnect", params)}
                        >
                          {t("mounts.shared.disconnect")}
                        </Button>
                      )}
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={locked || !rules.some((r) => r.value.autoMount)}
                        onClick={() =>
                          mutate("mounts.runtime.connectAndStartAuto", {
                            groupId: group.id,
                            expectedRevision: entry.revision,
                          })
                        }
                      >
                        {t("mounts.shared.startAuto")}
                      </Button>
                      {icon(
                        "mounts.shared.reconnect",
                        <RotateCw size={14} />,
                        () => mutate("mounts.groups.reconnect", params),
                        locked || disconnected,
                      )}
                      {icon(
                        "mounts.shared.editGroup",
                        <Pencil size={14} />,
                        () => setDraft({ type: "group", entry }),
                        locked || !disconnected,
                      )}
                      {icon("mounts.shared.removeGroup", <Trash2 size={14} />, () =>
                        confirm(
                          "mounts.shared.removeGroup",
                          () => mutate("mounts.groups.remove", { ...params, removeRules: true }),
                          true,
                        ),
                      )}
                    </div>
                  )}
                </div>
                {rules.map((rule) => {
                  const id = rule.value.id;
                  const state = snapshot.ruleStates.find((r) => r.ruleId === id);
                  const target = { id, expectedRevision: rule.revision };
                  return (
                    <div key={id} className="shared-mounts__row shared-mounts__rule">
                      <div>
                        <strong>{rule.value.name}</strong>{" "}
                        <span>{phase(state?.phase ?? "stopped")}</span>
                        <div className="shared-mounts__paths">
                          <code>{rule.value.remotePath}</code> →{" "}
                          <code>{rule.value.mountPoint}</code>
                        </div>
                        {state?.error && (
                          <div className="panel__error">{translateError(state.error.message)}</div>
                        )}
                      </div>
                      {write && (
                        <div className="shared-mounts__actions">
                          {state?.runtimeId || state?.desired
                            ? icon("mounts.shared.stop", <Square size={14} />, () =>
                                mutate("mounts.runtime.stop", {
                                  ...target,
                                  runtimeId: state.runtimeId ?? undefined,
                                }),
                              )
                            : icon(
                                "mounts.shared.start",
                                <Play size={14} />,
                                () => mutate("mounts.runtime.start", target),
                                locked || dependency === false,
                              )}
                          {state?.error &&
                            icon("mounts.shared.retry", <RotateCw size={14} />, () =>
                              mutate("mounts.runtime.retry", target),
                            )}
                          {state?.phase === "running" &&
                            icon("mounts.shared.open", <FolderOpen size={14} />, () =>
                              mutate(
                                "mounts.runtime.open",
                                { id, runtimeId: state.runtimeId },
                                false,
                              ),
                            )}
                          {icon(
                            "mounts.shared.editRule",
                            <Pencil size={14} />,
                            () => setDraft({ type: "rule", entry: rule }),
                            locked || !!state?.runtimeId || !!state?.desired,
                          )}
                          {icon("mounts.shared.removeRule", <Trash2 size={14} />, () =>
                            confirm(
                              "mounts.shared.removeRule",
                              () => mutate("mounts.rules.remove", target),
                              true,
                            ),
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
                {write && (
                  <Button
                    variant="ghost"
                    size="sm"
                    leading={<Plus size={14} />}
                    disabled={locked}
                    onClick={() =>
                      setDraft({
                        type: "rule",
                        entry: {
                          revision: "",
                          value: {
                            id: crypto.randomUUID(),
                            hostId,
                            groupId: group.id,
                            name: "",
                            remotePath: "/",
                            mountPoint: "",
                            readOnly: true,
                            autoMount: false,
                          },
                        },
                      })
                    }
                  >
                    {t("mounts.shared.newRule")}
                  </Button>
                )}
              </section>
            );
          })}
          {draft && write && (
            <form
              className="shared-mounts__group"
              onSubmit={(event) => {
                event.preventDefault();
                save();
              }}
            >
              <Field label={t("mounts.shared.name")}>
                <Input
                  required
                  maxLength={120}
                  value={draft.entry.value.name}
                  onChange={(event) => {
                    const name = event.target.value;
                    setDraft(
                      draft.type === "group"
                        ? {
                            ...draft,
                            entry: { ...draft.entry, value: { ...draft.entry.value, name } },
                          }
                        : {
                            ...draft,
                            entry: { ...draft.entry, value: { ...draft.entry.value, name } },
                          },
                    );
                  }}
                />
              </Field>
              {draft.type === "group" ? (
                <label>
                  <input
                    type="checkbox"
                    checked={draft.entry.value.autoReconnect}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        entry: {
                          ...draft.entry,
                          value: { ...draft.entry.value, autoReconnect: e.target.checked },
                        },
                      })
                    }
                  />{" "}
                  {t("mounts.shared.autoReconnect")}
                </label>
              ) : (
                <>
                  <Field label={t("mounts.shared.remotePath")}>
                    <Input
                      required
                      value={draft.entry.value.remotePath}
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          entry: {
                            ...draft.entry,
                            value: { ...draft.entry.value, remotePath: e.target.value },
                          },
                        })
                      }
                    />
                  </Field>
                  <Field label={t("mounts.shared.mountPoint")}>
                    <Input
                      required
                      value={draft.entry.value.mountPoint}
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          entry: {
                            ...draft.entry,
                            value: { ...draft.entry.value, mountPoint: e.target.value },
                          },
                        })
                      }
                    />
                  </Field>
                  <label>
                    <input
                      type="checkbox"
                      checked={draft.entry.value.readOnly}
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          entry: {
                            ...draft.entry,
                            value: { ...draft.entry.value, readOnly: e.target.checked },
                          },
                        })
                      }
                    />{" "}
                    {t("mounts.shared.readOnly")}
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      checked={draft.entry.value.autoMount}
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          entry: {
                            ...draft.entry,
                            value: { ...draft.entry.value, autoMount: e.target.checked },
                          },
                        })
                      }
                    />{" "}
                    {t("mounts.shared.autoMount")}
                  </label>
                </>
              )}
              <div className="shared-mounts__actions">
                <Button type="submit" size="sm" disabled={locked}>
                  {t("common.save")}
                </Button>
                <Button type="button" size="sm" variant="ghost" onClick={() => setDraft(undefined)}>
                  {t("common.cancel")}
                </Button>
              </div>
            </form>
          )}
          {legacy.length > 0 && (
            <section className="shared-mounts__group">
              <strong>{t("mounts.shared.legacy")}</strong>
              {legacy.map(({ mount }) => (
                <LegacyRow
                  key={mount.id}
                  mount={mount}
                  groups={snapshot.groups}
                  disabled={locked || !write}
                  convert={(group) =>
                    confirm("mounts.shared.migrate", () =>
                      mutate(
                        "mounts.legacy.convert",
                        {
                          id: mount.id,
                          ruleId: crypto.randomUUID(),
                          name: mount.remotePath.slice(0, 120),
                          groupId: group.value.id,
                          expectedGroupRevision: group.revision,
                        },
                        false,
                      ),
                    )
                  }
                />
              ))}
            </section>
          )}
        </>
      )}
      {operation && (
        <section className="shared-mounts__group" aria-label={t("mounts.shared.operation")}>
          <div role="status">
            {t("mounts.shared.operation")}: {phase(operation.phase)} (
            {operation.items.filter((item) => !["pending", "running"].includes(item.phase)).length}/
            {operation.items.length})
          </div>
          {operation.items
            .filter((item) => item.error)
            .map((item, index) => (
              <p className="panel__error" key={`${item.targetId}:${index}`}>
                {snapshot?.rules.find((r) => r.value.id === item.targetId)?.value.name ??
                  snapshot?.groups.find((g) => g.value.id === item.targetId)?.value.name ??
                  item.targetId}
                : {translateError(item.error?.message)}
              </p>
            ))}
          {write && operationId && (
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => mutate("mounts.operations.cancel", { id: operationId })}
            >
              {t("common.cancel")}
            </Button>
          )}
        </section>
      )}
    </div>
  );
}

function LegacyRow({
  mount,
  groups,
  disabled,
  convert,
}: {
  mount: LegacyMount["mount"];
  groups: MountEntry<MountGroup>[];
  disabled: boolean;
  convert: (group: MountEntry<MountGroup>) => void;
}) {
  const { t } = useTranslation();
  const [selected, setSelected] = useState("");
  const group = groups.find((g) => g.value.id === selected) ?? groups[0];
  return (
    <div className="shared-mounts__row">
      <div className="shared-mounts__paths">
        <code>{mount.remotePath}</code> → <code>{mount.mountPoint}</code>
      </div>
      {!disabled && group && (
        <div className="shared-mounts__actions">
          <Select
            label={t("mounts.shared.group")}
            value={group.value.id}
            options={groups.map((g) => ({ value: g.value.id, label: g.value.name }))}
            onChange={setSelected}
          />
          <Button size="sm" variant="secondary" onClick={() => convert(group)}>
            {t("mounts.shared.migrate")}
          </Button>
        </div>
      )}
    </div>
  );
}
