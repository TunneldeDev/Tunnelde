import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import Ajv from "ajv";
import { afterAll, beforeEach, expect, it, vi } from "vitest";
import { runPluginWorkspaceRequest } from "@/app/pluginWorkspaceBridge";
import { useWorkspace } from "@/store/workspace";
import type { PluginWorkspaceSnapshot } from "@/lib/plugins/workspace";
import floor from "../fixtures/plugin-compat/workspace-v1.json";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));

const ajv = new Ajv({ allErrors: true });
const contract = floor.methods["workspace.snapshot"];
const validate = ajv.compile(contract.resultSchema);
const samples: Record<string, unknown>[] = [];
async function read(params = {}) {
  const sample: Record<string, unknown> = {
    method: "workspace.snapshot",
    params,
    inputValid: true,
  };
  try {
    const result = (await runPluginWorkspaceRequest({
      requestId: "workspace-contract",
      pluginId: "workspace-contract",
      method: "workspace.snapshot",
      params,
    })) as PluginWorkspaceSnapshot;
    expect(validate(result), JSON.stringify(validate.errors)).toBe(true);
    sample.result = structuredClone(result);
    samples.push(sample);
    return result;
  } catch (error) {
    sample.frontendError = error instanceof Error ? error.message : String(error);
    if (!String(sample.frontendError).startsWith("pluginSecurity.")) samples.push(sample);
    throw error;
  }
}

beforeEach(() => {
  mocks.invoke.mockReset().mockResolvedValue(undefined);
  useWorkspace.setState({
    tabs: [],
    panes: [{ id: "p", tabIds: [], activeId: null }],
    activeId: null,
    activePaneId: "p",
    split: null,
    layout: { kind: "pane", paneId: "p" },
  });
});

it("preserves the empty workspace and optional field omission", async () => {
  expect(await read({ future: true })).toEqual({
    tabs: [],
    panes: [{ id: "p", tabIds: [], activeId: null }],
    activeId: null,
    activePaneId: "p",
    layout: { kind: "pane", paneId: "p" },
  });
});

function richState() {
  return {
    tabs: [
      {
        id: "files",
        kind: "sftp" as const,
        title: "资料",
        hostId: "host",
        pinned: false,
        preview: false,
        hidden: true,
        fileSessionId: "remote-session",
        privateDraft: "never expose",
        filePane: {
          source: {
            kind: "remote" as const,
            sessionId: "remote-session",
            credential: "never expose",
          },
          path: "/home/资料",
          ownerSessionId: "owner",
          offline: false,
          remoteIdentity: { hostId: "host", address: "user@host:22", token: "never expose" },
          view: {
            filesColumns: ["name", "size"] as ("name" | "size")[],
            filesColumnWidths: { name: 240, size: 91, privateCounter: 123 },
            filesLayout: "details" as const,
            filesShowHidden: true,
            filesFoldersFirst: false,
            filesSortBy: "name" as const,
            filesSortDirection: "desc" as const,
            filesGroupBy: "type" as const,
            privateQuery: "never expose",
          },
          privateWriter: "never expose",
        },
      },
    ],
    panes: [
      { id: "p", tabIds: ["files"], activeId: null, locked: false, privateCache: "never expose" },
      { id: "empty", tabIds: [], activeId: null, locked: true },
    ],
    activeId: null,
    activePaneId: "empty",
    layout: {
      kind: "split" as const,
      id: "root",
      direction: "row" as const,
      ratio: 0.4,
      privateSize: "never expose",
      first: { kind: "pane" as const, paneId: "p", privateNode: "never expose" },
      second: {
        kind: "split" as const,
        id: "nested",
        direction: "column" as const,
        ratio: 0.6,
        first: { kind: "pane" as const, paneId: "empty" },
        second: { kind: "pane" as const, paneId: "spare" },
      },
    },
  };
}

it("projects every documented nested field and isolates snapshots from future store fields and mutation", async () => {
  const state = richState();
  useWorkspace.setState(state);
  const snapshot = await read();
  expect(JSON.stringify(snapshot)).not.toMatch(/private|credential|token|never expose/);
  expect(snapshot.tabs[0]).toMatchObject({
    preview: false,
    hidden: true,
    fileSessionId: "remote-session",
    filePane: {
      source: { kind: "remote", sessionId: "remote-session" },
      path: "/home/资料",
      ownerSessionId: "owner",
      offline: false,
      remoteIdentity: { hostId: "host", address: "user@host:22" },
      view: {
        filesColumnWidths: { name: 240, size: 91 },
        filesShowHidden: true,
        filesFoldersFirst: false,
      },
    },
  });
  expect(snapshot.layout).toMatchObject({
    kind: "split",
    direction: "row",
    ratio: 0.4,
    second: { kind: "split", direction: "column", ratio: 0.6 },
  });
  expect(snapshot.panes[0]?.locked).toBe(false);
  // Mutating either side must not alter the other snapshot or the live store.
  const second = await read();
  snapshot.tabs[0]!.filePane!.view!.filesColumns!.push("modified");
  snapshot.tabs[0]!.filePane!.source.kind = "local";
  snapshot.tabs[0]!.filePane!.remoteIdentity!.address = "changed";
  snapshot.tabs[0]!.filePane!.view!.filesColumnWidths!.name = 999;
  snapshot.panes[0]!.tabIds.push("unknown");
  if (snapshot.layout.kind === "split") snapshot.layout.ratio = 0.8;
  expect(useWorkspace.getState().tabs).toEqual(state.tabs);
  expect(useWorkspace.getState().panes).toEqual(state.panes);
  expect(useWorkspace.getState().layout).toEqual(state.layout);
  expect(second.tabs[0]!.filePane!.view!.filesColumns).toEqual(["name", "size"]);
  state.tabs[0]!.title = "later";
  expect(second.tabs[0]!.title).toBe("资料");
});

it("preserves local file panes, explicit null sessions and unknown tab/option values", async () => {
  const state = richState();
  useWorkspace.setState({
    ...state,
    tabs: [
      {
        ...state.tabs[0]!,
        fileSessionId: null,
        filePane: { source: { kind: "local" }, path: null, ownerSessionId: "" },
      },
    ],
  });
  const snapshot = await read();
  expect(snapshot.tabs[0]!.fileSessionId).toBeNull();
  expect(snapshot.tabs[0]!.filePane).toEqual({
    source: { kind: "local" },
    path: null,
    ownerSessionId: "",
  });
  const future = {
    ...snapshot,
    tabs: [{ ...snapshot.tabs[0]!, kind: "future-view" }],
    future: true,
  };
  expect(validate(future)).toBe(true);
  const rich = await import("@/lib/plugins/workspace");
  const projected = rich.projectPluginWorkspace({
    ...future,
    tabs: [
      {
        ...future.tabs[0]!,
        filePane: {
          ...future.tabs[0]!.filePane!,
          view: {
            filesShowHidden: false,
            filesFoldersFirst: true,
            filesSortBy: "future-sort",
            filesSortDirection: "future-direction",
            filesLayout: "future-layout",
          },
        },
      },
    ],
  });
  expect(validate(projected)).toBe(true);
  expect(projected.tabs[0]!.filePane!.view!.filesSortBy).toBe("future-sort");
});

it("rejects malformed snapshots at each nested structural boundary", async () => {
  useWorkspace.setState(richState());
  const good = await read();
  const invalid: ((value: PluginWorkspaceSnapshot) => void)[] = [
    (value) => {
      delete (value as Partial<PluginWorkspaceSnapshot>).tabs;
    },
    (value) => {
      delete (value.tabs[0] as Partial<(typeof value.tabs)[0]>).hostId;
    },
    (value) => {
      value.tabs[0]!.filePane!.source = { kind: "remote" } as never;
    },
    (value) => {
      value.tabs[0]!.filePane!.view!.filesShowHidden = "yes" as never;
    },
    (value) => {
      value.panes[0]!.activeId = 123 as never;
    },
    (value) => {
      if (value.layout.kind === "split") value.layout.ratio = 2;
    },
    (value) => {
      if (value.layout.kind === "split") value.layout.first = { kind: "split" } as never;
    },
  ];
  for (const mutate of invalid) {
    const value = structuredClone(good);
    mutate(value);
    expect(validate(value)).toBe(false);
  }
});

it("reads current post-action state and keeps hidden panel placement intact", async () => {
  useWorkspace.getState().openPage("welcome", { preview: false });
  useWorkspace.getState().splitTab("sidebar:hosts", "column", "after", "root");
  const before = await read();
  useWorkspace.getState().close("sidebar:hosts");
  const hidden = await read();
  expect(hidden.layout).toEqual(before.layout);
  expect(hidden.tabs.find((tab) => tab.id === "sidebar:hosts")?.hidden).toBe(true);
  useWorkspace.getState().openSidebar("hosts");
  expect((await read()).layout).toEqual(before.layout);
});

it("requires authorization before accessing workspace state", async () => {
  mocks.invoke.mockRejectedValue(new Error("pluginSecurity.permissionDenied"));
  await expect(read()).rejects.toThrow("pluginSecurity.permissionDenied");
  expect(mocks.invoke).toHaveBeenCalledWith("plugin_workspace_authorize", {
    requestId: "workspace-contract",
  });
});

afterAll(() => {
  const path = process.env.TUNNELDE_WORKSPACE_CONTRACT_OUTPUT;
  if (path) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ samples }));
  }
});
