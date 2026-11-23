import { Pencil, Play, Plus, RefreshCw, Square, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, IconButton } from "@/components/ui/form/Button";
import { Field, Input } from "@/components/ui/form/Field";
import { PasswordInput } from "@/components/ui/form/PasswordInput";
import { SwitchRow } from "@/components/ui/form/Switch";
import { HelpHint } from "@/components/ui/form/HelpHint";
import { Select } from "@/components/ui/form/Select";
import { translateError } from "@/lib/api/errors";
import { useForwardingCaptureGuard } from "../runtime/useForwardingCaptureGuard";
import { useForwardingReadModel } from "../data/readScope";
import { proxyApi } from "../data/proxy";
import type {
  ProxyConnection,
  ProxyGroup,
  ProxyGroupInput,
  ProxyMissPolicy,
  ProxyRoute,
  ProxyRouteMode,
  ProxyRuntime,
} from "../model/proxy";

const emptyGroup = (hostId: string): ProxyGroupInput => ({
  id: "",
  hostId,
  name: "SOCKS5",
  listenHost: "127.0.0.1",
  listenPort: 1080,
  authMode: "none",
  authUsername: "",
  authPassword: null,
  missPolicy: "direct",
  autoStart: false,
  autoRetry: false,
});
const emptyRoute = (groupId: string): Omit<ProxyRoute, "revision"> => ({
  id: "",
  groupId,
  name: "",
  mode: "group",
  matchHost: "",
  matchPort: null,
  targetHost: "",
  targetPort: 80,
  bindHost: null,
  bindPort: null,
});

/** Compact SOCKS panel. Advanced details stay behind disclosure/tooltips so
 * host pages remain scannable at the same density as forwarding rules. */
export function ProxySection({
  hostId,
  hostName,
  onChanged,
}: {
  hostId: string;
  hostName: string;
  onChanged?: () => void;
}) {
  const { t } = useTranslation();
  const scoped = useForwardingReadModel();
  const formId = useId();
  const [groups, setGroups] = useState<ProxyGroup[]>([]);
  const [routes, setRoutes] = useState<Record<string, ProxyRoute[]>>({});
  const [runtime, setRuntime] = useState<ProxyRuntime[]>([]);
  const [connections, setConnections] = useState<ProxyConnection[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [groupDraft, setGroupDraft] = useState<ProxyGroupInput | null>(null);
  const [routeDraft, setRouteDraft] = useState<
    (Omit<ProxyRoute, "revision"> & { revision?: string }) | null
  >(null);
  useForwardingCaptureGuard("proxy-admission", () => busy);
  const load = useCallback(async () => {
    // A satellite consumes only its explicit forwarding projection. SOCKS5
    // administration remains a main-document surface until a scoped action
    // contract exists; never fall through to this document's raw IPC.
    if (scoped) return;
    try {
      const [groupSnapshot, runtimeSnapshot] = await Promise.all([
        proxyApi.groups(hostId),
        proxyApi.runtime(),
      ]);
      const nextGroups = Array.isArray(groupSnapshot) ? groupSnapshot : [];
      const nextRuntime = Array.isArray(runtimeSnapshot) ? runtimeSnapshot : [];
      const entries = await Promise.all(
        nextGroups.map(async (group) => [group.id, await proxyApi.routes(group.id)] as const),
      );
      setGroups(nextGroups);
      setRoutes(
        Object.fromEntries(
          entries.map(([id, snapshot]) => [id, Array.isArray(snapshot) ? snapshot : []]),
        ),
      );
      const live = nextRuntime.filter((item) => item.hostId === hostId);
      setRuntime(live);
      const current = await Promise.all(live.map((item) => proxyApi.connections(item.groupId)));
      setConnections(current.flatMap((snapshot) => (Array.isArray(snapshot) ? snapshot : [])));
      setError(null);
    } catch (cause) {
      setError(translateError(cause));
    }
  }, [hostId, scoped]);
  useEffect(() => {
    if (scoped) return;
    queueMicrotask(() => void load());
    const timer = window.setInterval(() => void load(), 4000);
    return () => window.clearInterval(timer);
  }, [load, scoped]);
  const run = async (operation: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await operation();
      await load();
      onChanged?.();
    } catch (cause) {
      setError(translateError(cause));
    } finally {
      setBusy(false);
    }
  };
  const saveGroup = () => {
    if (!groupDraft) return;
    const existing = groups.find((group) => group.id === groupDraft.id);
    void run(async () => {
      await proxyApi.saveGroup(groupDraft, existing?.revision);
      setGroupDraft(null);
    });
  };
  if (scoped) return null;
  const saveRoute = () => {
    if (!routeDraft) return;
    void run(async () => {
      const { revision, ...route } = routeDraft;
      await proxyApi.saveRoute(
        { ...route, name: route.name.trim() || route.matchHost.trim() },
        revision,
      );
      setRouteDraft(null);
    });
  };
  return (
    <section className="proxy-section" aria-busy={busy}>
      <header className="proxy-section__head">
        <div>
          <h3>{t("proxy.title")}</h3>
          <p>{t("proxy.subtitle", { host: hostName })}</p>
        </div>
        <div className="proxy-section__tools">
          <Button
            size="sm"
            leading={<Plus size={14} />}
            disabled={busy}
            onClick={() => setGroupDraft(emptyGroup(hostId))}
          >
            {t("proxy.addGroup")}
          </Button>
          <HelpHint label={t("proxy.title")}>{t("proxy.intro")}</HelpHint>
          <IconButton label={t("proxy.refresh")} disabled={busy} onClick={() => void load()}>
            <RefreshCw size={14} />
          </IconButton>
        </div>
      </header>
      {error ? (
        <p role="alert" className="td-field__error">
          {error}
        </p>
      ) : null}
      {groups.length === 0 && !groupDraft ? (
        <p className="proxy-section__empty">{t("proxy.empty")}</p>
      ) : null}
      {groups.map((group) => {
        const live = runtime.find((item) => item.groupId === group.id);
        const ownRoutes = routes[group.id] ?? [];
        const ownConnections = connections.filter((item) => item.groupId === group.id);
        return (
          <div className="proxy-group" key={group.id}>
            <div className="proxy-group__head">
              <div className="proxy-group__identity">
                <strong>{group.name}</strong>
                <code>{live?.socksEndpoint ?? `${group.listenHost}:${group.listenPort}`}</code>
              </div>
              <span className={`proxy-group__status ${live ? "is-running" : ""}`} role="status">
                {t(live ? "proxy.running" : "proxy.stopped")}
              </span>
              <IconButton
                size="sm"
                label={t(live ? "proxy.stop" : "proxy.start")}
                disabled={busy}
                onClick={() =>
                  void run(() =>
                    live
                      ? proxyApi.stop(group.id, group.revision, live.sessionId)
                      : proxyApi.start(group.id, group.revision),
                  )
                }
              >
                {live ? <Square size={14} /> : <Play size={14} />}
              </IconButton>
              <IconButton
                size="sm"
                label={t("common.edit")}
                disabled={busy || !!live}
                onClick={() =>
                  setGroupDraft({
                    id: group.id,
                    hostId: group.hostId,
                    name: group.name,
                    listenHost: group.listenHost,
                    listenPort: group.listenPort,
                    authMode: group.authMode,
                    authUsername: group.authUsername,
                    authPassword: null,
                    missPolicy: group.missPolicy,
                    autoStart: group.autoStart,
                    autoRetry: group.autoRetry,
                  })
                }
              >
                <Pencil size={13} />
              </IconButton>
              <IconButton
                size="sm"
                label={t("common.delete")}
                disabled={busy || !!live || ownRoutes.length > 0}
                onClick={() => void run(() => proxyApi.removeGroup(group.id, group.revision))}
              >
                <Trash2 size={13} />
              </IconButton>
            </div>
            {live?.exposureWarning ? (
              <p className="proxy-group__warning">{t("proxy.exposure")}</p>
            ) : null}
            <div className="proxy-group__meta">
              <span>{t(`proxy.miss.${group.missPolicy}`)}</span>
              <span>{t("proxy.routeCount", { count: ownRoutes.length })}</span>
              {group.autoStart ? <span>{t("proxy.autoStart")}</span> : null}
            </div>
            <ul className="proxy-routes">
              {ownRoutes.map((route) => (
                <li key={route.id} className="proxy-route">
                  <div className="proxy-route__identity">
                    <strong>{route.name || route.matchHost}</strong>
                    <code>
                      {route.matchHost}
                      {route.matchPort ? `:${route.matchPort}` : ""} → {route.targetHost}:
                      {route.targetPort}
                    </code>
                  </div>
                  <span className="proxy-route__mode">{t(`proxy.mode.${route.mode}`)}</span>
                  <IconButton
                    size="sm"
                    label={t("common.edit")}
                    disabled={busy || !!live}
                    onClick={() => setRouteDraft({ ...route })}
                  >
                    <Pencil size={13} />
                  </IconButton>
                  <IconButton
                    size="sm"
                    label={t("common.delete")}
                    disabled={busy || !!live}
                    onClick={() => void run(() => proxyApi.removeRoute(route.id, route.revision))}
                  >
                    <X size={13} />
                  </IconButton>
                </li>
              ))}
            </ul>
            <Button
              size="sm"
              variant="ghost"
              leading={<Plus size={13} />}
              disabled={busy || !!live}
              onClick={() => setRouteDraft(emptyRoute(group.id))}
            >
              {t("proxy.addRoute")}
            </Button>
            {ownConnections.length ? (
              <details className="proxy-connections">
                <summary>{t("proxy.connections", { count: ownConnections.length })}</summary>
                <ul>
                  {ownConnections.map((connection) => (
                    <li key={connection.id}>
                      <code>
                        {connection.source} → {connection.target}
                      </code>
                      <span>
                        ↑{connection.bytesUp} ↓{connection.bytesDown}
                      </span>
                      <IconButton
                        size="sm"
                        label={t("proxy.closeConnection")}
                        onClick={() => void run(() => proxyApi.closeConnection(connection.id))}
                      >
                        <X size={12} />
                      </IconButton>
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
          </div>
        );
      })}
      {groupDraft ? (
        <form
          className="proxy-editor"
          onSubmit={(event) => {
            event.preventDefault();
            saveGroup();
          }}
        >
          <h4>{t(groupDraft.id ? "proxy.editGroup" : "proxy.addGroup")}</h4>
          <div className="proxy-editor__grid">
            <Field label={t("proxy.name")} htmlFor={`${formId}-name`}>
              <Input
                id={`${formId}-name`}
                value={groupDraft.name}
                onChange={(event) => setGroupDraft({ ...groupDraft, name: event.target.value })}
              />
            </Field>
            <Field
              label={t("proxy.listenAddress")}
              htmlFor={`${formId}-listen`}
              hint={t("proxy.listenHint")}
              hintPresentation="tooltip"
            >
              <Input
                id={`${formId}-listen`}
                value={groupDraft.listenHost}
                onChange={(event) =>
                  setGroupDraft({ ...groupDraft, listenHost: event.target.value })
                }
              />
            </Field>
            <Field label={t("proxy.listenPort")} htmlFor={`${formId}-port`}>
              <Input
                id={`${formId}-port`}
                type="number"
                min={1}
                max={65535}
                value={groupDraft.listenPort}
                onChange={(event) =>
                  setGroupDraft({ ...groupDraft, listenPort: Number(event.target.value) })
                }
              />
            </Field>
            <Field label={t("proxy.auth")} htmlFor={`${formId}-auth`}>
              <Select
                id={`${formId}-auth`}
                label={t("proxy.auth")}
                value={groupDraft.authMode}
                options={[
                  { value: "none", label: t("proxy.authNone") },
                  { value: "password", label: t("proxy.authPassword") },
                ]}
                onChange={(value) =>
                  setGroupDraft({ ...groupDraft, authMode: value as ProxyGroupInput["authMode"] })
                }
              />
            </Field>
            <Field label={t("proxy.miss")} htmlFor={`${formId}-miss`}>
              <Select
                id={`${formId}-miss`}
                label={t("proxy.miss")}
                value={groupDraft.missPolicy}
                options={(["direct", "remote", "reject"] as ProxyMissPolicy[]).map((value) => ({
                  value,
                  label: t(`proxy.miss.${value}`),
                }))}
                onChange={(value) =>
                  setGroupDraft({ ...groupDraft, missPolicy: value as ProxyMissPolicy })
                }
              />
            </Field>
            {groupDraft.authMode === "password" ? (
              <>
                <Field label={t("proxy.username")} htmlFor={`${formId}-user`}>
                  <Input
                    id={`${formId}-user`}
                    autoComplete="off"
                    value={groupDraft.authUsername}
                    onChange={(event) =>
                      setGroupDraft({ ...groupDraft, authUsername: event.target.value })
                    }
                  />
                </Field>
                <Field
                  label={t("proxy.password")}
                  htmlFor={`${formId}-password`}
                  hint={t("proxy.passwordHint")}
                  hintPresentation="tooltip"
                >
                  <PasswordInput
                    id={`${formId}-password`}
                    autoComplete="new-password"
                    value={groupDraft.authPassword ?? ""}
                    onChange={(event) =>
                      setGroupDraft({ ...groupDraft, authPassword: event.target.value })
                    }
                  />
                </Field>
              </>
            ) : null}
          </div>
          <SwitchRow
            label={t("proxy.autoStart")}
            hint={t("proxy.autoStartHint")}
            hintPresentation="tooltip"
            checked={groupDraft.autoStart}
            onChange={(autoStart) => setGroupDraft({ ...groupDraft, autoStart })}
          />
          <SwitchRow
            label={t("proxy.autoRetry")}
            hint={t("proxy.autoRetryHint")}
            hintPresentation="tooltip"
            checked={groupDraft.autoRetry}
            onChange={(autoRetry) => setGroupDraft({ ...groupDraft, autoRetry })}
          />
          <div className="proxy-editor__actions">
            <Button variant="ghost" onClick={() => setGroupDraft(null)}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" variant="primary" disabled={busy || !groupDraft.name.trim()}>
              {t("common.save")}
            </Button>
          </div>
        </form>
      ) : null}
      {routeDraft ? (
        <form
          className="proxy-editor"
          onSubmit={(event) => {
            event.preventDefault();
            saveRoute();
          }}
        >
          <h4>{t("proxy.addRoute")}</h4>
          <div className="proxy-editor__grid">
            <Field label={t("proxy.name")} htmlFor={`${formId}-route-name`}>
              <Input
                id={`${formId}-route-name`}
                value={routeDraft.name}
                onChange={(event) => setRouteDraft({ ...routeDraft, name: event.target.value })}
              />
            </Field>
            <Field label={t("proxy.modeLabel")} htmlFor={`${formId}-mode`}>
              <Select
                id={`${formId}-mode`}
                label={t("proxy.modeLabel")}
                value={routeDraft.mode}
                options={(["group", "dedicated"] as ProxyRouteMode[]).map((value) => ({
                  value,
                  label: t(`proxy.mode.${value}`),
                }))}
                onChange={(value) =>
                  setRouteDraft({
                    ...routeDraft,
                    mode: value as ProxyRouteMode,
                    bindHost: value === "dedicated" ? (routeDraft.bindHost ?? "127.0.0.1") : null,
                    bindPort: value === "dedicated" ? (routeDraft.bindPort ?? 1081) : null,
                  })
                }
              />
            </Field>
            <Field
              label={t("proxy.matchHost")}
              htmlFor={`${formId}-match`}
              hint={t("proxy.matchHint")}
              hintPresentation="tooltip"
            >
              <Input
                id={`${formId}-match`}
                value={routeDraft.matchHost}
                onChange={(event) =>
                  setRouteDraft({ ...routeDraft, matchHost: event.target.value })
                }
              />
            </Field>
            <Field label={t("proxy.matchPort")} htmlFor={`${formId}-match-port`}>
              <Input
                id={`${formId}-match-port`}
                type="number"
                min={1}
                max={65535}
                value={routeDraft.matchPort ?? ""}
                onChange={(event) =>
                  setRouteDraft({
                    ...routeDraft,
                    matchPort: event.target.value ? Number(event.target.value) : null,
                  })
                }
              />
            </Field>
            <Field label={t("proxy.targetHost")} htmlFor={`${formId}-target`}>
              <Input
                id={`${formId}-target`}
                value={routeDraft.targetHost}
                onChange={(event) =>
                  setRouteDraft({ ...routeDraft, targetHost: event.target.value })
                }
              />
            </Field>
            <Field label={t("proxy.targetPort")} htmlFor={`${formId}-target-port`}>
              <Input
                id={`${formId}-target-port`}
                type="number"
                min={1}
                max={65535}
                value={routeDraft.targetPort}
                onChange={(event) =>
                  setRouteDraft({ ...routeDraft, targetPort: Number(event.target.value) })
                }
              />
            </Field>
            {routeDraft.mode === "dedicated" ? (
              <>
                <Field
                  label={t("proxy.bindHost")}
                  htmlFor={`${formId}-bind`}
                  hint={t("proxy.bindHint")}
                  hintPresentation="tooltip"
                >
                  <Input
                    id={`${formId}-bind`}
                    value={routeDraft.bindHost ?? "127.0.0.1"}
                    onChange={(event) =>
                      setRouteDraft({ ...routeDraft, bindHost: event.target.value })
                    }
                  />
                </Field>
                <Field label={t("proxy.bindPort")} htmlFor={`${formId}-bind-port`}>
                  <Input
                    id={`${formId}-bind-port`}
                    type="number"
                    min={1}
                    max={65535}
                    value={routeDraft.bindPort ?? ""}
                    onChange={(event) =>
                      setRouteDraft({
                        ...routeDraft,
                        bindPort: event.target.value ? Number(event.target.value) : null,
                      })
                    }
                  />
                </Field>
              </>
            ) : null}
          </div>
          <div className="proxy-editor__actions">
            <Button variant="ghost" onClick={() => setRouteDraft(null)}>
              {t("common.cancel")}
            </Button>
            <Button
              type="submit"
              variant="primary"
              disabled={
                busy ||
                !routeDraft.matchHost.trim() ||
                !routeDraft.targetHost.trim() ||
                (routeDraft.mode === "dedicated" && (!routeDraft.bindHost || !routeDraft.bindPort))
              }
            >
              {t("common.save")}
            </Button>
          </div>
        </form>
      ) : null}
    </section>
  );
}
