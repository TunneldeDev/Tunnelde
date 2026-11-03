import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/form/Button";
import { Field, Input } from "@/components/ui/form/Field";
import { Select } from "@/components/ui/form/Select";
import { useSsh } from "@/store/ssh";
import { translateError } from "@/lib/api/errors";
import { authorizePluginAction } from "@/store/pluginSecurity";
import { useDialogs } from "@/store/dialogs";

interface Mount {
  id: string;
  sessionId: string;
  remotePath: string;
  mountPoint: string;
  readOnly: boolean;
  cleanupError?: string | null;
}
interface Dependencies {
  available: boolean;
  platform: string;
  instructions: string;
  documentation: string;
  executable?: string | null;
  transport?: string | null;
}
export function PluginMounts({ pluginId }: { pluginId: string }) {
  const { i18n, t } = useTranslation();
  const zh = i18n.language.startsWith("zh");
  const sessions = useSsh((s) => s.sessions);
  const [sessionId, setSession] = useState(sessions[0]?.id ?? "");
  const selectedSession = sessionId ? sessions.find((s) => s.id === sessionId) : sessions[0];
  const [remotePath, setRemote] = useState("/");
  const [mountPoint, setPoint] = useState("");
  const [readOnly, setReadOnly] = useState(true);
  const [mounts, setMounts] = useState<Mount[]>([]);
  const [deps, setDeps] = useState<Dependencies | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);
  const running = useRef(false);
  const [directories, setDirectories] = useState<{ name: string; path: string }[] | null>(null);
  const call = useCallback(
    <T,>(method: string, params: unknown = {}) =>
      invoke<T>("plugin_mounts_action", { pluginId, method, params }),
    [pluginId],
  );
  const refresh = useCallback(async () => {
    const [dependencies, records] = await Promise.all([
      call<Dependencies>("dependencies"),
      call<Mount[]>("list"),
    ]);
    if (mounted.current) {
      setDeps(dependencies);
      setMounts(records);
    }
  }, [call]);
  useEffect(() => {
    let alive = true;
    mounted.current = true;
    Promise.all([call<Dependencies>("dependencies"), call<Mount[]>("list")])
      .then(([dependencies, records]) => {
        if (alive && !running.current) {
          setDeps(dependencies);
          setMounts(records);
          setSession((current) => current || sessions[0]?.id || "");
        }
      })
      .catch((e) => {
        if (alive) setError(translateError(e));
      });
    return () => {
      alive = false;
      mounted.current = false;
    };
  }, [call, sessions]);
  const run = async (action: () => Promise<unknown>) => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError("");
    try {
      if (await authorizePluginAction(pluginId)) {
        await action();
        await refresh();
      }
    } catch (e) {
      if (mounted.current) setError(translateError(e));
      await refresh().catch(() => {});
    } finally {
      running.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  return (
    <section className="plugin-tool plugin-mounts" aria-label="SSHFS" aria-busy={busy}>
      <p>
        {zh
          ? "通过已连接的 SSH 会话挂载远端目录，复用其认证、代理与跳板设置。"
          : "Mount a remote directory through a connected SSH session, reusing its authentication, proxy and jump hosts."}
      </p>
      {error && (
        <p className="panel__error" role="alert">
          {error}
        </p>
      )}
      {deps && !deps.available ? (
        <>
          <p>
            {t(
              `mounts.install.${deps.platform === "windows" ? "windows" : deps.platform === "macos" ? "macos" : "linux"}`,
            )}
          </p>
          {deps.executable && !deps.transport ? <p>{t("mounts.install.transport")}</p> : null}
          <Button
            onClick={() =>
              void invoke("plugin_mounts_action", { pluginId, method: "documentation", params: {} })
            }
          >
            {zh ? "安装说明" : "Installation guide"}
          </Button>
          <Button variant="ghost" onClick={() => void run(refresh)}>
            {zh ? "重新检测" : "Check again"}
          </Button>
        </>
      ) : null}
      <Field label={zh ? "远端会话" : "Remote session"}>
        <Select
          label="SSH session"
          value={sessionId || sessions[0]?.id || ""}
          options={[
            ...sessions.map((s) => ({ value: s.id, label: s.title })),
            ...(sessionId && !selectedSession
              ? [{ value: sessionId, label: t("mounts.disconnected") }]
              : []),
          ]}
          onChange={setSession}
        />
      </Field>
      {!sessions.length && (
        <p>
          {zh
            ? "请先连接一个主机，再在此选择会话。"
            : "Connect to a host first, then select its session here."}
        </p>
      )}
      <Field label={zh ? "远端目录" : "Remote directory"}>
        <div className="field-row">
          <Input
            aria-label={zh ? "远端目录" : "Remote directory"}
            value={remotePath}
            onChange={(e) => {
              setRemote(e.target.value);
              setDirectories(null);
            }}
            placeholder="/home"
          />
          <Button
            variant="ghost"
            disabled={busy || !selectedSession}
            onClick={() =>
              void run(async () => {
                const listing = await call<{
                  path: string;
                  entries: { name: string; path: string }[];
                }>("browse", { sessionId: selectedSession?.id, path: remotePath });
                setRemote(listing.path);
                setDirectories(listing.entries);
              })
            }
          >
            {zh ? "浏览…" : "Browse…"}
          </Button>
        </div>
      </Field>
      {directories && (
        <div className="plugin-mounts__directories">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setRemote(remotePath.split("/").slice(0, -1).join("/") || "/");
              setDirectories(null);
            }}
          >
            ..
          </Button>
          {directories.map((dir) => (
            <Button
              key={dir.path}
              variant="ghost"
              size="sm"
              onClick={() => {
                setRemote(dir.path);
                setDirectories(null);
              }}
            >
              {dir.name}
            </Button>
          ))}
        </div>
      )}
      <Field
        label={
          deps?.platform === "windows"
            ? zh
              ? "未占用的盘符"
              : "Unused drive letter"
            : zh
              ? "本地空目录"
              : "Empty local directory"
        }
      >
        <div className="field-row">
          <Input
            aria-label={zh ? "本地挂载位置" : "Local mount point"}
            value={mountPoint}
            onChange={(e) => setPoint(e.target.value)}
            placeholder={deps?.platform === "windows" ? "Z:\\" : "/home/me/mount"}
          />
          {deps?.platform !== "windows" && (
            <Button
              variant="ghost"
              onClick={() =>
                void invoke<string | null>("plugin_pick_folder", {
                  title: zh ? "选择本地空目录" : "Choose an empty local directory",
                })
                  .then((path) => {
                    if (path) setPoint(path);
                  })
                  .catch((e) => setError(translateError(e)))
              }
            >
              {zh ? "选择…" : "Browse…"}
            </Button>
          )}
        </div>
      </Field>
      <Field label={zh ? "访问方式" : "Access"}>
        <Select
          label="Access"
          value={readOnly ? "ro" : "rw"}
          options={[
            { value: "ro", label: zh ? "只读（推荐）" : "Read only (recommended)" },
            { value: "rw", label: zh ? "读写" : "Read and write" },
          ]}
          onChange={(v) => setReadOnly(v === "ro")}
        />
      </Field>
      <Button
        variant="primary"
        disabled={
          busy || !deps?.available || !selectedSession || !mountPoint || !remotePath.startsWith("/")
        }
        onClick={() =>
          void run(() =>
            call("mount", {
              sessionId: selectedSession?.id,
              remotePath,
              mountPoint,
              readOnly,
            }),
          )
        }
      >
        {zh ? "挂载" : "Mount"}
      </Button>
      <hr />
      {mounts.map((m) => (
        <div key={m.id} className="settings-row">
          <div className="settings-row__text">
            <strong>{m.mountPoint}</strong>
            <code>
              {sessions.find((s) => s.id === m.sessionId)?.title ?? t("mounts.disconnected")} ·{" "}
              {m.remotePath} ·{" "}
              {m.readOnly ? (zh ? "只读" : "Read only") : zh ? "读写" : "Read/write"}
            </code>
            {m.cleanupError && (
              <p className="panel__error">{t(m.cleanupError, { defaultValue: m.cleanupError })}</p>
            )}
          </div>
          <div className="field-row">
            <Button
              size="sm"
              disabled={busy || !!m.cleanupError}
              onClick={() => void run(() => call("open", { id: m.id }))}
            >
              {zh ? "打开" : "Open"}
            </Button>
            <Button
              size="sm"
              disabled={busy}
              onClick={() => void run(() => call("unmount", { id: m.id, force: false }))}
            >
              {zh ? "卸载" : "Unmount"}
            </Button>
            <Button
              size="sm"
              variant="ghost-danger"
              disabled={busy}
              onClick={() =>
                useDialogs.getState().confirm({
                  title: zh ? "强制卸载？" : "Force unmount?",
                  body: zh
                    ? "请先保存并关闭使用此挂载的文件。强制卸载可能丢失未保存的数据。"
                    : "Save and close files using this mount. Forcing unmount can lose unsaved data.",
                  confirmLabel: zh ? "强制卸载" : "Force unmount",
                  danger: true,
                  onConfirm: () => run(() => call("unmount", { id: m.id, force: true })),
                })
              }
            >
              {zh ? "强制卸载…" : "Force…"}
            </Button>
          </div>
        </div>
      ))}
    </section>
  );
}
