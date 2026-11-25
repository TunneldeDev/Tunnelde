import { DEFAULT_SETTINGS } from "@/lib/prefs/defaults";
import type { Host, Group, FileEntry, Settings, PluginInfo } from "@/lib/api/types";
import type { DebugParameters } from "./contracts";
const instant = 1_795_558_400_000;
let parameters: DebugParameters;
let hosts: Host[] = [];
let groups: Group[] = [];
let files: FileEntry[] = [];
let forwards: Record<string, unknown>[] = [];
let forwardGroups: Record<string, unknown>[] = [];
let proxies: Record<string, unknown>[] = [];
let routes: Record<string, unknown>[] = [];
let settings: Settings = structuredClone(DEFAULT_SETTINGS);
const text = new Map<string, string>();
const subscribers = new Map<string, Set<(payload: unknown) => void>>();
export function listenFixture(name: string, handler: (payload: unknown) => void) {
  const set = subscribers.get(name) ?? new Set();
  set.add(handler);
  subscribers.set(name, set);
  return Promise.resolve(() => {
    set.delete(handler);
    if (!set.size) subscribers.delete(name);
  });
}
function emit(name: string, payload: unknown) {
  for (const receive of subscribers.get(name) ?? []) receive(payload);
}
function id(index: number) {
  return `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;
}
export function initializeFixture(input: DebugParameters) {
  parameters = input;
  text.clear();
  let state = input.seed >>> 0;
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
  settings = {
    ...structuredClone(DEFAULT_SETTINGS),
    theme: input.theme,
    language: input.locale,
    autoCheckUpdates: false,
    restoreWorkspace: false,
    terminalRenderer: "dom",
    titleBarStyle: "system",
    disconnectOnPanelClose: false,
  };
  const count =
    input.preset === "empty"
      ? 0
      : input.preset === "boundary"
        ? Math.max(1000, input.count)
        : input.count;
  groups = Array.from({ length: input.preset === "empty" ? 0 : 4 }, (_, i) => ({
    id: `group-${i}`,
    name: ["生产环境 Production", "亚洲区 / Asia", "开发环境", "归档 Archive"][i]!,
    parentId: i === 1 ? "group-0" : i === 3 ? "group-1" : null,
    sortOrder: i,
    createdAt: instant,
    updatedAt: instant,
  }));
  hosts = Array.from({ length: count }, (_, i) => ({
    id: id(i),
    name:
      input.preset === "boundary" && i % 3 === 0
        ? `边界主机-${i} · ${"长名称 Unicode 🚇 日本語 العربية ".repeat(6)}`
        : `Tunnel-${String(i + 1).padStart(3, "0")}`,
    host: `192.0.${Math.floor(random() * 254)}.${(i % 250) + 1}`,
    port: 22,
    username: i % 2 ? "developer" : "root",
    authMethod: "password",
    keyPath: null,
    groupId: `group-${i % 4}`,
    favorite: i < 3,
    color: null,
    tags: [i % 2 ? "dev" : "production", "synthetic"],
    note: "合成验收数据 / Synthetic acceptance data",
    sortOrder: i,
    lastUsedAt: instant,
    createdAt: instant,
    updatedAt: instant,
  }));
  files = Array.from({ length: count }, (_, i) => {
    const name =
      i === 0
        ? "README.md"
        : input.preset === "boundary"
          ? `文件-${i}-${"长名称🚇".repeat(8)}.ts`
          : i % 5 === 0
            ? `directory-${i}`
            : `source-${i}.ts`;
    return {
      name,
      path: `/debug/${name}`,
      isDir: i > 0 && i % 5 === 0,
      size: i * 2048,
      modified: instant / 1000,
      permissions: 420,
      isHidden: false,
    };
  });
  forwards = hosts.slice(0, 12).map((host, i) => ({
    id: `forward-${i}`,
    hostId: host.id,
    name: input.preset === "boundary" ? "长名称转发 🚇 ".repeat(10) : `Web service ${i}`,
    mode: i % 2 ? "remote" : "local",
    bindHost: "127.0.0.1",
    bindPort: 8000 + i,
    targetHost: "localhost",
    targetPort: 80 + i,
    groupId: null,
    revision: "fixture-1",
    active: i % 2 === 0,
    sessionId: i % 2 === 0 ? "debug-session" : null,
  }));
  forwardGroups = hosts.slice(0, 4).map((host, i) => ({
    id: `forward-group-${i}`,
    hostId: host.id,
    name: `Forward group ${i}`,
    revision: "fixture-1",
  }));
  proxies = hosts.slice(0, 4).map((host, i) => ({
    id: `proxy-${i}`,
    hostId: host.id,
    name: `SOCKS5 ${i}`,
    listenHost: "127.0.0.1",
    listenPort: 1080 + i,
    authMode: "none",
    authUsername: "",
    missPolicy: "remote",
    autoStart: false,
    autoRetry: false,
    revision: "fixture-1",
  }));
  routes = proxies.map((group, i) => ({
    id: `route-${i}`,
    groupId: group.id,
    name: `Route ${i}`,
    mode: "group",
    matchHost: "*.example.test",
    matchPort: null,
    targetHost: "localhost",
    targetPort: 80,
    revision: "fixture-1",
  }));
  text.set(
    "/debug/README.md",
    "# Tunnelde 场景验收\n\n这是生产编辑器中的合成文档。\n\n```ts\nexport const tunnel = '🚇';\n```\n",
  );
  return { hosts, groups, settings, files, instant };
}
export function fixturePlugin(): PluginInfo {
  return {
    id: "debug.fixture",
    name: "合成插件 / Fixture plugin",
    version: "1.0.0",
    apiVersion: 1,
    description: "开发场景示例；不执行外部插件代码。",
    commands: [{ id: "fixture.submit", title: "提交验收表单" }],
    views: [{ id: "default", title: "合成插件视图", kind: "blocks", location: "workspace" }],
    permissions: [],
    status: parameters.preset === "error" ? "failed" : "running",
    error: parameters.preset === "error" ? "模拟插件错误" : null,
    runtimeId: "fixture-runtime",
    fingerprint: "fixture-v1",
    path: "/debug/plugins",
    runtime: "declarative",
  };
}
export function fixtureSnapshot() {
  return {
    preset: parameters.preset,
    hosts: hosts.length,
    files: files.length,
    settings: { theme: settings.theme, language: settings.language },
    subscribers: [...subscribers.entries()].map(([name, set]) => ({ name, count: set.size })),
  };
}
export async function invokeFixture<T>(
  command: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  if (!parameters) throw new Error("Debugger fixture was not initialized");
  const error = () => {
    throw { code: "io", message: "模拟故障：连接不可用 / Injected unavailable connection" };
  };
  const dataRead =
    /^(local_list|sftp_list|remote_stats|history_list|known_hosts_list|forwarding_list|forwarding_groups_list|proxy_groups_list|proxy_routes_list|proxy_runtime_list|logs_output_read|local_read_text|sftp_read_text|remote_processes|processes_snapshot)$/.test(
      command,
    );
  if (dataRead && parameters.preset === "error") error();
  if (dataRead && parameters.preset === "loading") return new Promise<T>(() => {});
  let value: unknown;
  switch (command) {
    case "settings_get":
      value = settings;
      break;
    case "settings_update":
      settings = { ...settings, ...(args.patch as Partial<Settings>) };
      value = settings;
      emit("settings://changed", settings);
      break;
    case "settings_reset":
      settings = structuredClone(DEFAULT_SETTINGS);
      value = settings;
      break;
    case "app_info":
      value = {
        name: "Tunnelde",
        version: "debugger-fixture",
        tauriVersion: "2",
        os: "macos",
        arch: "aarch64",
        debug: true,
        dataDir: "/debug",
        logDir: "/debug/logs",
        defaultSettings: DEFAULT_SETTINGS,
        schema: {},
        systemLanguages: [parameters.locale],
      };
      break;
    case "hosts_snapshot":
      value = { hosts, groups };
      break;
    case "host_create": {
      const host = {
        ...hosts[0],
        id: crypto.randomUUID(),
        createdAt: instant,
        updatedAt: instant,
        sortOrder: hosts.length,
        tags: [],
        groupId: null,
        note: null,
        favorite: false,
        color: null,
        keyPath: null,
        lastUsedAt: null,
        port: 22,
        username: "root",
        authMethod: "password",
        ...(args.input as object),
      } as Host;
      hosts.push(host);
      value = host;
      break;
    }
    case "host_update":
      hosts = hosts.map((host) =>
        host.id === args.id ? { ...host, ...(args.input as object) } : host,
      );
      value = hosts.find((host) => host.id === args.id);
      break;
    case "host_delete":
      hosts = hosts.filter((host) => host.id !== args.id);
      break;
    case "host_editor_save": {
      const edit = args.edit as { id: string | null; input: object };
      const host = edit.id
        ? await invokeFixture<Host>("host_update", { id: edit.id, input: edit.input })
        : await invokeFixture<Host>("host_create", { input: edit.input });
      value = { host, credentialError: null };
      break;
    }
    case "group_create": {
      const group = {
        id: crypto.randomUUID(),
        parentId: null,
        sortOrder: groups.length,
        createdAt: instant,
        updatedAt: instant,
        ...(args.input as object),
      } as Group;
      groups.push(group);
      value = group;
      break;
    }
    case "group_update":
      groups = groups.map((group) =>
        group.id === args.id ? { ...group, ...(args.input as object) } : group,
      );
      value = groups.find((group) => group.id === args.id);
      break;
    case "group_delete":
      groups = groups.filter((group) => group.id !== args.id);
      break;
    case "connection_review_prepare":
      value = {
        review: { hostId: (args.displayed as Host).id, revision: "fixture-1" },
        jumpHosts: [],
      };
      break;
    case "connection_review_probe":
      value = {
        hostId: (args.review as { hostId: string }).hostId,
        fingerprint: "SHA256:synthetic-test-fingerprint",
        algorithm: "ssh-ed25519",
        status: "unknown",
        knownFingerprint: null,
      };
      break;
    case "connection_review_trust":
      value = {
        info: {
          hostId: (args.review as { hostId: string }).hostId,
          fingerprint: args.fingerprint,
          algorithm: "ssh-ed25519",
          status: "known",
          knownFingerprint: null,
        },
        review: args.review,
      };
      break;
    case "connection_review_connect":
    case "ssh_connect":
      value = {
        id: "debug-session",
        hostId: (args.request as { hostId: string }).hostId,
        title: "Fixture terminal",
        address: "debugger@fixture.test:22",
        cols: 100,
        rows: 30,
        connectedAt: instant,
        terminal: true,
      };
      break;
    case "connection_review_credential":
      value = null;
      break;
    case "remote_processes":
      value = Array.from(
        { length: parameters.preset === "empty" ? 0 : parameters.count },
        (_, i) => ({
          pid: i + 100,
          name: i === 0 ? "Tunnelde fixture 🚇" : `worker-${i}`,
          cpu: i % 100,
          memory: i % 70,
          rss: i * 1024 * 1024,
          userName: "debugger",
          state: "S",
          threads: 4,
        }),
      );
      break;
    case "connection_route_get":
      value = { jumpHosts: [], proxy: { kind: "direct" } };
      break;
    case "credential_status":
      value = false;
      break;
    case "ssh_probe":
    case "ssh_trust":
      value = {
        hostId: args.hostId,
        fingerprint: "SHA256:synthetic-test-fingerprint",
        algorithm: "ssh-ed25519",
        status: command === "ssh_trust" ? "known" : "unknown",
        knownFingerprint: null,
      };
      break;
    case "ssh_sessions":
      value = [];
      break;
    case "ssh_write": {
      emit("ssh://data", { sessionId: args.sessionId, data: args.data, sequence: instant });
      break;
    }
    case "local_home":
    case "sftp_home":
    case "sftp_realpath":
    case "local_resolve_path":
      value = "/debug";
      break;
    case "local_list":
    case "sftp_list":
      value = {
        path: String(args.path ?? "/debug"),
        entries: files.map((file) => ({
          ...file,
          path: `${String(args.path ?? "/debug").replace(/\/$/, "")}/${file.name}`,
        })),
      };
      break;
    case "local_read_text":
    case "sftp_read_text":
    case "search_preview_local": {
      const content = text.get(String(args.path)) ?? "export const scenario = 'Tunnelde';\n";
      value = {
        content,
        size: new TextEncoder().encode(content).length,
        encoding: "utf-8",
        bom: false,
      };
      break;
    }
    case "local_write_text":
    case "sftp_write_text":
      text.set(String(args.path), String(args.content));
      break;
    case "local_mkdir":
    case "sftp_mkdir":
    case "local_create_file":
    case "sftp_create_file": {
      const path = String(args.path);
      files.push({
        name: path.split("/").at(-1)!,
        path,
        isDir: command.endsWith("mkdir"),
        size: 0,
        modified: instant / 1000,
        permissions: 420,
        isHidden: false,
      });
      break;
    }
    case "local_delete":
    case "sftp_delete":
      files = files.filter((file) => file.path !== args.path);
      break;
    case "remote_stats":
      value = {
        cpuPercent: parameters.preset === "boundary" ? 100 : 32,
        cpuCount: 8,
        memoryUsed: 6e9,
        memoryTotal: 16e9,
        swapUsed: 0,
        swapTotal: 4e9,
        diskUsed: 128e9,
        diskTotal: 512e9,
        load: [1.2, 0.8, 0.5],
        uptime: 86400,
        netRxRate: 65536,
        netTxRate: 32768,
        diskReadRate: 0,
        diskWriteRate: 0,
        sampledAt: instant,
        processes: [],
      };
      break;
    case "history_list":
      value = Array.from(
        { length: parameters.preset === "empty" ? 0 : parameters.count },
        (_, i) => ({
          id: i + 1,
          hostId: hosts[0]?.id,
          sessionId: "debug-session",
          command: `echo '场景 ${i}'`,
          executedAt: instant - i * 1000,
          at: instant - i * 1000,
          createdAt: instant - i * 1000,
        }),
      );
      break;
    case "known_hosts_list":
      value = hosts.slice(0, 20).map((host) => ({
        host: host.host,
        port: host.port,
        fingerprint: "SHA256:synthetic-test-fingerprint",
        algorithm: "ssh-ed25519",
        updatedAt: instant,
        createdAt: instant,
      }));
      break;
    case "logs_output_read":
      value = {
        diagnostic:
          parameters.preset === "empty"
            ? ""
            : Array.from(
                { length: parameters.count },
                (_, i) => `[INFO] Scenario event ${i} · 合成诊断数据`,
              ).join("\n"),
        operations: [],
        cursor: { filename: "debug.jsonl", offset: 0, operationId: 0 },
        truncated: false,
      };
      break;
    case "logs_read":
      value = {
        diagnostic: "Synthetic scenario log",
        operations: [],
        filename: null,
        truncated: false,
      };
      break;
    case "update_state":
    case "update_check":
      value = {
        phase: parameters.preset === "error" ? "error" : "upToDate",
        currentVersion: "0.1.0",
        channel: "stable",
        source: "github",
        sourceUrl: "",
        version: null,
        notes: null,
        publishedAt: null,
        progress: null,
        contentLength: null,
        error: parameters.preset === "error" ? "模拟更新错误" : null,
        lastChecked: instant,
        available: false,
        autoInstall: false,
        unsupportedReason: null,
        downloadUrl: null,
        skipped: false,
      };
      break;
    case "plugin_render_view":
      value = {
        title: "合成插件视图 / Fixture plugin view",
        blocks: [
          { type: "heading", text: "已登记的插件扩展" },
          { type: "text", text: "复用生产声明式插件渲染器；此场景不执行第三方代码。" },
          {
            type: "table",
            columns: ["Key", "Value"],
            rows: [
              ["Seed", String(parameters.seed)],
              ["Locale", parameters.locale],
            ],
          },
          {
            type: "form",
            id: "acceptance",
            fields: [
              {
                id: "name",
                type: "text",
                label: "场景名称",
                value: "Fixture",
                placeholder: "",
                options: [],
              },
            ],
            actions: [{ id: "submit", label: "提交", command: "fixture.submit" }],
          },
        ],
      };
      break;
    case "plugin_run":
      if (args.command !== "fixture.submit") throw new Error("Unregistered fixture plugin command");
      value = { text: "已完成合成插件操作", title: "Fixture result", error: false };
      break;
    case "plugin_list":
    case "plugins_list":
      value = parameters.preset === "empty" ? [] : [fixturePlugin()];
      break;
    case "plugin_security":
    case "plugin_security_state":
      value = { restricted: true, grants: [], reviews: [], disabled: [] };
      break;
    case "plugin_node_info":
    case "node_runtime_info":
      value = {
        available: false,
        version: null,
        path: null,
        source: null,
        consent: false,
        installing: false,
      };
      break;
    case "settings_profiles_snapshot":
      value = { profiles: [], revision: "fixture-1" };
      break;
    case "habits_snapshot":
      value = { revision: "fixture-1", enabled: true, categories: {}, entries: [] };
      break;
    case "storage_status":
      value = { categories: [], pending: null, root: "/debug" };
      break;
    case "fonts_catalogue":
      value = { version: 1, items: [] };
      break;
    case "plugin_config":
      value = { sources: [], nodePath: null };
      break;
    case "plugin_market_catalogue":
      value = { plugins: [], sources: [], errors: [] };
      break;
    case "forwarding_list":
      value = forwards;
      break;
    case "forwarding_groups_list":
      value = forwardGroups;
      break;
    case "forwarding_save": {
      const rule: Record<string, unknown> = {
        ...(args.rule as object),
        revision: crypto.randomUUID(),
        active: false,
        sessionId: null,
      };
      forwards = [...forwards.filter((item) => item.id !== rule.id), rule];
      value = rule;
      break;
    }
    case "forwarding_remove":
      forwards = forwards.filter((item) => item.id !== args.id);
      break;
    case "proxy_groups_list":
      value = proxies.filter((group) => group.hostId === args.hostId);
      break;
    case "proxy_routes_list":
      value = routes.filter((route) => route.groupId === args.groupId);
      break;
    case "proxy_group_save": {
      const group: Record<string, unknown> = {
        ...(args.group as object),
        revision: crypto.randomUUID(),
      };
      proxies = [...proxies.filter((item) => item.id !== group.id), group];
      value = group;
      break;
    }
    case "proxy_group_remove":
      proxies = proxies.filter((item) => item.id !== args.id);
      break;
    case "proxy_route_save": {
      const route: Record<string, unknown> = {
        ...(args.route as object),
        revision: crypto.randomUUID(),
      };
      routes = [...routes.filter((item) => item.id !== route.id), route];
      value = route;
      break;
    }
    case "proxy_connections_list":
      value = [];
      break;
    case "proxy_runtime_list":
      value = [];
      break;
    case "ssh_forward_list":
    case "market_sources":
    case "settings_profiles_list":
    case "tabs_snapshot":
    case "durable_transfer_list":
    case "editor_cleanup_list":
    case "runner_recovery_owners":
    case "plugin_host_sources":
    case "plugin_host_columns":
    case "plugin_status_bar":
    case "plugin_tab_bar":
      value = [];
      break;
    case "host_fields_get":
      value = { schema: { fields: [] }, values: {}, revision: 0 };
      break;
    case "ssh_attach":
      value = null;
      break;
    case "ssh_detach":
      value = 0;
      break;
    case "ssh_resize":
    case "ssh_disconnect":
    case "tabs_save":
    case "host_mark_used":
    case "hosts_reorder":
    case "set_locale":
    case "history_record":
    case "logs_report":
    case "plugin_log":
    case "file_preview_close":
      value = null;
      break;
    default:
      throw {
        code: "validation",
        message: `调试场景未实现此操作 / Unsupported fixture operation: ${command}`,
      };
  }
  return structuredClone(value) as T;
}
