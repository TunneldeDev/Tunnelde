/** Development-only document entry. Commands remain coordinator scoped. */
import { useEffect, useState } from "react";
import { EditorView } from "@codemirror/view";
import { invoke } from "@tauri-apps/api/core";
import { emitTo, listen } from "@tauri-apps/api/event";
import { App } from "@/App";
import { SatelliteApp } from "@/app/SatelliteApp";
import { bootstrap } from "@/app/bootstrap";
import { useHosts } from "@/store/hosts";
import { useSettings } from "@/store/settings";
import { useNavigation, type SettingsSection } from "@/store/navigation";
import { useWorkspace } from "@/store/workspace";
import { useEditors } from "@/store/editors";
import { useSsh } from "@/store/ssh";
import { api } from "@/lib/api/ipc";
import { mainPanelWindowClient } from "@/app/panelWindows";
import { movePanelToWindow } from "@/lib/panels/windowMoves";
import { canonicalWorkspacePanelId } from "@/features/editor/editorWindowRegistration";
import type { Host } from "@/lib/api/types";
import type { DebugParameters } from "./contracts";
import { prepareScene, SceneView, snapshot } from "./index";
interface Request {
  generation: number;
  scenarioId: string;
  parameters: DebugParameters;
  mode: string;
  prepared: { hosts?: Host[]; fileRoot?: string; fixture?: { password: string; port: number } };
}
const message = (cause: unknown) =>
  cause instanceof Error
    ? cause.message
    : typeof cause === "object" && cause && "message" in cause
      ? String(cause.message)
      : String(cause);
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function prepareReal(request: Request) {
  await bootstrap();
  await Promise.all([useHosts.getState().load(), useSettings.getState().load()]);
  const { scenarioId: id, prepared } = request;
  const workspace = useWorkspace.getState();
  if (id.startsWith("settings-")) {
    workspace.openPage("settings");
    useNavigation.getState().selectSettings(id.slice(9) as SettingsSection);
  } else if (id === "hosts") {
    workspace.ensureWelcome();
    useNavigation.getState().showSidebar("hosts");
  } else if (id === "host-details" && prepared.hosts?.[0]) workspace.openHost(prepared.hosts[0]);
  else if (["editor", "floating"].includes(id)) {
    const path = `${prepared.fileRoot}/README.md`;
    workspace.openLocalEditor(path);
    const tab = useWorkspace.getState().tabs.find((tab) => tab.kind === "editor")!;
    await useEditors.getState().open(tab.id, null, path);
    if (id === "floating") useWorkspace.getState().floatTab(tab.id);
  } else if (id === "terminal" || id === "files") {
    const host = prepared.hosts?.[0];
    if (!host || !prepared.fixture) throw new Error("SSH fixture requires at least one host");
    const key = await api.sshProbe(host.id);
    await api.sshTrust(host.id, key.fingerprint);
    const session = await useSsh
      .getState()
      .connect({ hostId: host.id, password: prepared.fixture.password, cols: 100, rows: 30 });
    if (!session) throw new Error("Controlled SSH connection failed");
    if (id === "terminal") workspace.openTerminal(session);
    else {
      // Both panes start in fixture-owned roots; never enumerate the user's home.
      workspace.openFilePane(
        { source: { kind: "local" }, path: prepared.fileRoot!, ownerSessionId: "local" },
        "Local fixture",
      );
      const remote = workspace.openFilePane(
        {
          source: { kind: "remote", sessionId: session.id },
          path: "/",
          ownerSessionId: session.id,
          remoteIdentity: { hostId: host.id, address: session.address },
        },
        "SFTP fixture",
      );
      useWorkspace.getState().splitTab(remote, "row", "after");
    }
  } else workspace.ensureWelcome();
}
function editorView() {
  const node = document.querySelector<HTMLElement>(".cm-editor");
  return node ? EditorView.findFromDOM(node) : null;
}
function editorSelection() {
  const range = editorView()?.state.selection.main;
  return range ? { anchor: range.anchor, head: range.head } : null;
}
function realSnapshot() {
  return {
    tabs: useWorkspace.getState().tabs.map(({ id, kind, filePane }) => ({ id, kind, filePane })),
    hosts: useHosts.getState().hosts.length,
    sessions: useSsh.getState().sessions.map(({ id, hostId }) => ({ id, hostId })),
    theme: useSettings.getState().settings.theme,
    locale: useSettings.getState().settings.language,
    editors: Object.entries(useEditors.getState().entries).map(([id, entry]) => ({
      id,
      loading: entry.loading,
      error: entry.error,
      dirty: entry.content !== entry.baseline,
      draftFingerprint: Array.from(entry.content).reduce(
        (hash, char) => Math.imul(hash ^ char.codePointAt(0)!, 16777619) >>> 0,
        2166136261,
      ),
      selection: editorSelection(),
    })),
  };
}
async function verifyReal() {
  const checks: string[] = [];
  const input = {
    name: "Debugger verification host",
    host: "example.test",
    username: "debugger",
    authMethod: "password" as const,
    tags: ["synthetic"],
  };
  const host = await api.createHost(input);
  await api.updateHost(host.id, { ...input, name: "Updated verification host" });
  await useHosts.getState().load();
  if (
    useHosts.getState().hosts.find((item) => item.id === host.id)?.name !==
    "Updated verification host"
  )
    throw new Error("Host service/store mismatch");
  await api.deleteHost(host.id);
  await useHosts.getState().load();
  checks.push("host create/update/read/delete");
  const settings = await api.settings();
  await api.updateSettings({ theme: settings.theme === "dark" ? "light" : "dark" });
  await useSettings.getState().load();
  if (useSettings.getState().settings.theme === settings.theme)
    throw new Error("Settings service/store mismatch");
  await api.updateSettings({ theme: settings.theme });
  await useSettings.getState().load();
  checks.push("settings write/read/restore");
  const entry = Object.values(useEditors.getState().entries)[0];
  if (entry) {
    const content = entry.content + "\nNative verification 🚇\n";
    useEditors.getState().change(entry.tabId, content);
    if (!(await useEditors.getState().save(entry.tabId))) throw new Error("Editor save failed");
    if ((await api.localReadText(entry.path)).content !== content)
      throw new Error("Editor/backend file mismatch");
    useEditors.getState().change(entry.tabId, content + "Unsaved round-trip draft", {
      start: 2,
      end: 7,
      direction: "forward",
      scrollTop: 0,
      scrollLeft: 0,
    });
    await delay(200);
    editorView()?.dispatch({ selection: { anchor: 2, head: 7 } });
    checks.push("local editor save/read and pending draft");
  }
  const session = useSsh.getState().sessions[0];
  if (session) {
    await api.sshWrite(session.id, btoa("debugger-input\r"));
    await api.sftpList(session.id, "/");
    const name = `/check-${crypto.randomUUID()}.txt`;
    await api.sftpCreateFile(session.id, name);
    await api.sftpWriteText(session.id, name, "SSH/SFTP acceptance 🚇", "", "utf-8", false);
    if ((await api.sftpReadText(session.id, name)).content !== "SSH/SFTP acceptance 🚇")
      throw new Error("SFTP write/read mismatch");
    await api.sftpDelete(session.id, name, false);
    if (!(await api.sshSessions()).some((item) => item.id === session.id))
      throw new Error("SSH session was replaced");
    checks.push("SSH terminal input; same-session SFTP create/write/read/delete");
  }
  return { checks, state: realSnapshot() };
}
async function present(placement: string) {
  const client = mainPanelWindowClient();
  if (!client) throw new Error("Native ownership coordinator unavailable");
  const tabs = useWorkspace.getState().tabs;
  const tab =
    tabs.find((tab) => tab.filePane?.source.kind === "remote") ??
    tabs.find((tab) => ["editor", "terminal", "sftp", "files", "host", "page"].includes(tab.kind));
  if (!tab) throw new Error("No registered movable page");
  const panelId = canonicalWorkspacePanelId(tab.id);
  if (placement === "floating") {
    useWorkspace.getState().floatTab(tab.id);
    return { placement, panelId };
  }
  const state = await client.snapshot();
  const lease = state.panels.find((item) => item.panelId === panelId);
  if (!lease) throw new Error("Panel has not registered ownership yet");
  if (placement === "native") await movePanelToWindow(panelId);
  else if (lease.windowId !== "main") {
    const id = crypto.randomUUID();
    await emitTo(lease.windowId, "debugger://return", { id, panelId });
    const deadline = Date.now() + 25000;
    while (Date.now() < deadline) {
      const snapshot = await client.snapshot();
      if (snapshot.panels.some((panel) => panel.panelId === panelId && panel.windowId === "main"))
        break;
      await delay(100);
    }
  }
  const result = await client.snapshot();
  const owner = result.panels.find((item) => item.panelId === panelId);
  if (!owner || (placement === "native" ? owner.windowId === "main" : owner.windowId !== "main"))
    throw new Error("Window ownership did not commit");
  if (placement === "main" && tab.kind === "editor") {
    const deadline = Date.now() + 10000;
    while (
      (!editorView() ||
        Object.values(useEditors.getState().entries).some((entry) => entry.loading)) &&
      Date.now() < deadline
    )
      await delay(50);
  }
  return { placement, owner, windows: result.windows, state: realSnapshot() };
}
export function NativeEntry() {
  const [request, setRequest] = useState<Request>();
  const [mode, setMode] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    let disposed = false;
    let generation = 0;
    const start = async () => {
      const context = await invoke<{ mode: string }>("debugger_context");
      if (disposed) return;
      setMode(context.mode);
      while (!disposed) {
        const polled = await invoke<{
          request?: Request;
          action?: { id: string; generation: number; placement: string };
        }>("debugger_poll", { generation });
        if (disposed) break;
        if (polled.request) {
          const next = polled.request;
          // A new mock document tears down all subscriptions and singleton caches.
          if (generation > 0 && context.mode === "native-mock") {
            location.reload();
            return;
          }
          generation = next.generation;
          try {
            if (context.mode === "native-mock")
              await prepareScene(
                { id: next.scenarioId, surface: next.scenarioId, title: next.scenarioId },
                next.parameters,
              );
            else await prepareReal(next);
            if (disposed) return;
            setRequest(next);
            await invoke("main_window_ready");
          } catch (cause) {
            const detail = message(cause);
            setError(detail);
            await invoke("debugger_ack", { generation, snapshot: {}, error: detail });
            await invoke("main_window_ready");
          }
        }
        if (polled.action) {
          const action = polled.action;
          let result;
          try {
            result = {
              ok: true,
              ...(await (action.placement === "verify"
                ? context.mode === "native-mock"
                  ? Promise.resolve({ state: snapshot(), checks: ["production mock mounted"] })
                  : verifyReal()
                : present(action.placement))),
            };
          } catch (cause) {
            result = { ok: false, error: message(cause) };
          }
          await invoke("debugger_result", { generation, id: action.id, result });
        }
        await delay(150);
      }
    };
    void start().catch((cause) => {
      if (!disposed) setError(message(cause));
    });
    return () => {
      disposed = true;
    };
  }, []);
  useEffect(() => {
    if (!request) return;
    let cancelled = false;
    // A timer also works while a hidden WebKit document throttles animation frames.
    const timer = setTimeout(() => {
      if (cancelled) return;
      const alert = document.querySelector('[role="alert"]');
      void invoke("debugger_ack", {
        generation: request.generation,
        snapshot: mode === "native-mock" ? snapshot() : realSnapshot(),
        error: alert?.textContent || null,
      });
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [request, mode]);
  if (error) return <pre role="alert">{error}</pre>;
  if (mode === "native-service") return <App />;
  return request ? (
    <SceneView
      key={request.generation}
      scene={{ id: request.scenarioId, surface: request.scenarioId, title: request.scenarioId }}
      parameters={request.parameters}
    />
  ) : (
    <div role="status">Waiting for debugger scenario…</div>
  );
}
export function DebugSatelliteEntry() {
  useEffect(() => {
    let disposed = false;
    let stop: (() => void) | undefined;
    void listen<{ id: string; panelId: string }>("debugger://return", async ({ payload }) => {
      if (disposed) return;
      let error: string | undefined;
      try {
        await movePanelToWindow(payload.panelId, "main");
      } catch (cause) {
        error = message(cause);
      }
      if (error) console.error("debugger window return:", error);
    }).then((unlisten) => {
      if (disposed) unlisten();
      else stop = unlisten;
    });
    return () => {
      disposed = true;
      stop?.();
    };
  }, []);
  return <SatelliteApp />;
}
