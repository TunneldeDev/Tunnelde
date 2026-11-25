import "@xterm/xterm/css/xterm.css";
import "@fontsource/ibm-plex-sans/latin-400.css";
import "@fontsource/jetbrains-mono/latin-400.css";
import "@/styles/tokens.css";
import "@/styles/base.css";
import "@/styles/app.css";
import "@/styles/workbench.css";
import "@/styles/plugins.css";
import "@/styles/settings.css";
import "@/styles/colors.css";
import "@/styles/corners.css";
import "@/i18n/i18n";
import { registerBackgroundTaskSources } from "@/app/backgroundTaskSources";
import { useEffect, useState } from "react";
import { AppShell } from "@/components/layout/AppShell";
import { useHosts } from "@/store/hosts";
import { useSsh } from "@/store/ssh";
import { useEditors } from "@/store/editors";
import { useWorkspace } from "@/store/workspace";
import { useNavigation, type BuiltinSidebarView, type SettingsSection } from "@/store/navigation";
import { useSettings, applySettings } from "@/store/settings";
import { useDialogs } from "@/store/dialogs";
import { usePlugins } from "@/store/plugins";
import { useQuickAccess } from "@/store/quickAccess";
import { useTransfers } from "@/store/transfers";
import { useFilePreview } from "@/store/filePreview";
import { useHostTransfer } from "@/lib/hosts/transfer";
import { toast } from "@/store/toasts";
import { Field, Input, Textarea } from "@/components/ui/form/Field";
import { Button } from "@/components/ui/form/Button";
import { SwitchRow } from "@/components/ui/form/Switch";
import { Dialog } from "@/components/ui/overlay/Dialog";
import { ProcessesDialog } from "@/features/monitor/ProcessesDialog";
import { EditorConflictDialog } from "@/features/editor/EditorConflictDialog";
import { initializeFixture, fixtureSnapshot, fixturePlugin } from "./mock";
import type { DebugParameters, DebugScene } from "./contracts";
const session = {
  id: "debug-session",
  hostId: "00000000-0000-4000-8000-000000000001",
  title: "验收终端 / Acceptance terminal",
  address: "tester@fixture.test:22",
  cols: 100,
  rows: 30,
  connectedAt: 1_795_558_400_000,
  terminal: true,
};
export const capabilities = {
  protocol: 1,
  rendering: "production-components",
  targets: ["browser", "native-mock", "native-service"],
};
export function snapshot() {
  return {
    fixture: fixtureSnapshot(),
    tabs: useWorkspace.getState().tabs.map((tab) => ({ id: tab.id, kind: tab.kind })),
    dialog: useDialogs.getState().dialog.kind,
  };
}
let releaseTasks: (() => void) | undefined;
export async function prepareScene(scene: DebugScene, parameters: DebugParameters) {
  if (!import.meta.env.DEV || import.meta.env.VITE_TUNNELDE_DEBUGGER !== "1")
    throw new Error("Development debugger is disabled");
  window.__TUNNELDE_DEBUGGER_MOCK__ = true;
  releaseTasks?.();
  releaseTasks = registerBackgroundTaskSources();
  const data = initializeFixture(parameters);
  useWorkspace.setState({
    tabs: [],
    panes: [{ id: "main", tabIds: [], activeId: null }],
    activePaneId: "main",
    activeId: null,
    layout: { kind: "pane", paneId: "main" },
    split: null,
  });
  useDialogs.getState().close();
  useQuickAccess.getState().close();
  useHosts.setState({
    hosts: data.hosts,
    groups: data.groups,
    loaded: parameters.preset !== "loading",
    loading: parameters.preset === "loading",
  });
  useSsh.setState({
    sessions: parameters.preset === "empty" ? [] : [session],
    history: [],
    connectingHostId: null,
    connectingHostIds: [],
    disconnectingSessionIds: [],
  });
  useEditors.setState({ entries: {} });
  useSettings.setState({
    settings: data.settings,
    ready: true,
    error: null,
    saving: false,
    info: {
      name: "Tunnelde",
      version: "debugger-fixture",
      tauriVersion: "2",
      os: "macos",
      arch: "aarch64",
      debug: true,
      dataDir: "/debug",
      logDir: "/debug/logs",
      defaultSettings: data.settings,
      schema: {
        languages: ["system", "zh-CN", "en-US"],
        themes: ["dark", "light", "system"],
        accents: ["blue", "cyan", "green", "orange", "violet"],
        densities: ["comfortable", "compact"],
      },
    },
  });
  applySettings(data.settings);
  useNavigation.setState({
    activeSidebar: "hosts",
    sidebarVisible: true,
    visitedSidebars: ["hosts"],
    settingsSection: "general",
  });
  const plugin = fixturePlugin();
  usePlugins.setState({
    items: parameters.preset === "empty" ? [] : [plugin],
    busy: null,
    busyIds: [],
    outputs: {},
  });
  useTransfers.setState({
    items:
      parameters.preset === "empty"
        ? []
        : Array.from({ length: Math.min(parameters.count, 100) }, (_, i) => ({
            id: `transfer-${i}`,
            name: `构建产物-${i}.tar.gz`,
            direction: "transfer" as const,
            transferred: i * 1024,
            total: 100 * 1024,
            status:
              parameters.preset === "error"
                ? ("failed" as const)
                : i % 3 === 0
                  ? ("paused" as const)
                  : ("running" as const),
            error: parameters.preset === "error" ? "模拟传输失败" : null,
            updatedAt: data.instant,
          })),
  });
  const workspace = useWorkspace.getState();
  const sidebar: Record<string, BuiltinSidebarView> = {
    hosts: "hosts",
    connections: "connections",
    forwarding: "forwarding",
    socks: "forwarding",
    plugins: "plugins",
    tasks: "tasks",
    output: "output",
    "known-hosts": "knownHosts",
    preview: "filePreview",
  };
  if (scene.id === "workbench") {
    workspace.openFilePane(
      { ownerSessionId: "local", source: { kind: "local" }, path: "/debug" },
      "Fixture files",
    );
    workspace.openLocalEditor("/debug/README.md");
    const tab = useWorkspace.getState().tabs.find((tab) => tab.kind === "editor")!;
    await useEditors.getState().open(tab.id, null, "/debug/README.md");
    workspace.splitTab(tab.id, "row", "after");
  } else if (scene.id.startsWith("settings-")) {
    workspace.openPage("settings");
    useNavigation.getState().selectSettings(scene.id.slice(9) as SettingsSection);
  } else if (sidebar[scene.id]) {
    workspace.ensureWelcome();
    useNavigation.getState().showSidebar(sidebar[scene.id]!);
    if (
      ["hosts", "plugins", "forwarding", "socks"].includes(scene.id) &&
      data.hosts[0] &&
      ["forwarding", "socks"].includes(scene.id)
    )
      workspace.openHost(data.hosts[0]);
  } else if (scene.id === "host-details" && data.hosts[0]) workspace.openHost(data.hosts[0]);
  else if (scene.id === "terminal") workspace.openTerminal(session);
  else if (scene.id === "files")
    workspace.openFilePane(
      { ownerSessionId: "local", source: { kind: "local" }, path: "/debug" },
      "文件验收",
    );
  else if (["editor", "editor-conflict", "floating"].includes(scene.id)) {
    workspace.openLocalEditor("/debug/README.md");
    const tab = useWorkspace.getState().tabs.find((tab) => tab.kind === "editor")!;
    const loading = useEditors.getState().open(tab.id, null, "/debug/README.md");
    if (parameters.preset !== "loading") await loading;
    if (scene.id === "floating") workspace.floatTab(tab.id);
  } else if (scene.id === "monitor" || scene.id === "processes") workspace.openMonitor(session);
  else if (scene.id === "history") workspace.openHistory(session);
  else if (scene.id === "plugin-details")
    workspace.openPluginDetail("local", plugin.id, plugin.name);
  else if (scene.id === "plugin-view") workspace.openPluginView(plugin.id, "default", "插件视图");
  else if (scene.id === "about") workspace.openPage("about");
  else workspace.ensureWelcome();
  if (scene.id === "connect")
    useDialogs.getState().openConnect(
      data.hosts[0] ?? {
        ...session,
        id: session.hostId,
        name: "空态测试主机",
        host: "fixture.test",
        port: 22,
        username: "tester",
        authMethod: "password",
        keyPath: null,
        groupId: null,
        color: null,
        favorite: false,
        tags: [],
        note: null,
        sortOrder: 0,
        lastUsedAt: null,
        createdAt: data.instant,
        updatedAt: data.instant,
      },
    );
  if (scene.id === "host-transfer") useHostTransfer.setState({ dialog: { kind: "export" } });
  if (scene.id === "dialogs")
    useDialogs.getState().confirm({
      title: "确认测试操作",
      body: "这是合成验收场景。操作只会更改当前场景数据。",
      confirmLabel: "确认",
      danger: parameters.preset === "error",
      onConfirm: () => toast("已确认", "success"),
    });
  if (scene.id === "menus") useQuickAccess.getState().show(">");
  if (scene.id === "notifications") {
    toast("操作已完成 / Operation completed", "success");
    toast("模拟错误：请检查连接状态", "error");
  }
  if (scene.id === "preview") useFilePreview.getState().show("/debug/README.md");
}
export function SceneView({
  scene,
  parameters,
  onReady,
}: {
  scene: DebugScene;
  parameters: DebugParameters;
  onReady?: () => void;
}) {
  useEffect(() => {
    const timer = requestAnimationFrame(() => onReady?.());
    return () => cancelAnimationFrame(timer);
  }, [onReady]);
  const [extraOpen, setExtraOpen] = useState(true);
  const editor = useWorkspace((state) => state.tabs.find((tab) => tab.kind === "editor")?.id);
  return (
    <div data-debug-surface={scene.id} style={{ height: "100vh", width: "100%" }}>
      <AppShell />
      {extraOpen && scene.id === "processes" && (
        <ProcessesDialog sessionId={session.id} onClose={() => setExtraOpen(false)} />
      )}
      {extraOpen && scene.id === "editor-conflict" && editor && (
        <EditorConflictDialog tabId={editor} onClose={() => setExtraOpen(false)} />
      )}
      {extraOpen && scene.id === "forms" && (
        <FixtureForms parameters={parameters} onClose={() => setExtraOpen(false)} />
      )}
    </div>
  );
}
function FixtureForms({
  parameters,
  onClose,
}: {
  parameters: DebugParameters;
  onClose: () => void;
}) {
  const [name, setName] = useState(
    parameters.preset === "boundary" ? "长表单标签 🚇 ".repeat(15) : "验收主机",
  );
  const [enabled, setEnabled] = useState(true);
  return (
    <Dialog
      open
      title="公共表单控件 / Shared form controls"
      onClose={onClose}
      closeLabel="关闭"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button
            disabled={parameters.preset === "disabled" || !name}
            onClick={() => {
              toast("已保存场景表单", "success");
              onClose();
            }}
          >
            保存
          </Button>
        </>
      }
    >
      <Field
        label="名称"
        htmlFor="debug-name"
        error={parameters.preset === "error" || !name ? "请输入有效名称" : null}
      >
        <Input
          id="debug-name"
          value={name}
          disabled={parameters.preset === "disabled"}
          onChange={(event) => setName(event.target.value)}
        />
      </Field>
      <Field label="备注" htmlFor="debug-note">
        <Textarea id="debug-note" defaultValue="使用实际生产控件，检查焦点、选区与输入。" />
      </Field>
      <SwitchRow label="启用连接" checked={enabled} onChange={setEnabled} />
    </Dialog>
  );
}
