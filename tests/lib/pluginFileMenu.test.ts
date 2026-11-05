import { beforeEach, describe, expect, it, vi } from "vitest";
import { fileMenuCommands, runFileMenuCommand } from "@/lib/plugins/fileMenu";
import { usePlugins } from "@/store/plugins";
import { useSsh } from "@/store/ssh";
import { useWorkspace } from "@/store/workspace";
import { useToasts } from "@/store/toasts";
import i18n from "@/i18n/i18n";
import { plugin } from "../fixtures/plugins";

const file = {
  name: "test.json",
  path: "/work/test.json",
  isDir: false,
  isHidden: false,
  size: 5,
  modified: null,
  permissions: null,
};
const source = { kind: "remote" as const, sessionId: "ssh-1" };
const contribution = {
  ...plugin,
  status: "running" as const,
  permissions: ["sftp.read"],
  commands: [
    {
      id: "inspect",
      title: "Inspect",
      fileMenu: { sources: ["remote" as const], kinds: ["file" as const], extensions: ["json"] },
    },
  ],
};

beforeEach(() => {
  useToasts.setState({ items: [] });
  usePlugins.setState({ items: [contribution], execute: vi.fn().mockResolvedValue({}) });
  useSsh.setState({ sessions: [{ id: "ssh-1" } as never] });
});

describe("file menu contributions", () => {
  it("filters by source, type, extension, and declared permissions", () => {
    expect(fileMenuCommands([contribution], source, file)).toHaveLength(1);
    expect(fileMenuCommands([contribution], { kind: "local" }, file)).toHaveLength(0);
    expect(fileMenuCommands([contribution], source, { ...file, isDir: true })).toHaveLength(0);
    expect(fileMenuCommands([contribution], source, { ...file, name: "test.txt" })).toHaveLength(0);
    expect(fileMenuCommands([{ ...contribution, permissions: [] }], source, file)).toHaveLength(0);
  });
  it("passes the explicitly selected file after permission checks", async () => {
    const action = fileMenuCommands([contribution], source, file)[0]!;
    await runFileMenuCommand(action, source, file);
    const execute = vi.mocked(usePlugins.getState().execute);
    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0]![2]()).toEqual({
      file: { path: file.path, name: file.name, isDirectory: false, source },
    });
  });
  it("does not show an error when the user declines plugin permission", async () => {
    usePlugins.setState({ execute: vi.fn().mockRejectedValue(new Error("plugin.permissionDenied")) });
    await runFileMenuCommand(fileMenuCommands([contribution], source, file)[0]!, source, file);
    expect(useToasts.getState().items).toEqual([]);
  });
  it("does not run a contribution from a replaced plugin or disconnected session", async () => {
    const action = fileMenuCommands([contribution], source, file)[0]!;
    usePlugins.setState({ items: [{ ...contribution, fingerprint: "different" }] });
    await runFileMenuCommand(action, source, file);
    expect(usePlugins.getState().execute).not.toHaveBeenCalled();
    expect(useToasts.getState().items.at(-1)?.message).toBe(i18n.t("pluginSecurity.changed"));
    usePlugins.setState({ items: [contribution] });
    useSsh.setState({ sessions: [] });
    await runFileMenuCommand(action, source, file);
    expect(usePlugins.getState().execute).not.toHaveBeenCalled();
  });
  it("rechecks the session after the permission prompt before exposing the path", async () => {
    const action = fileMenuCommands([contribution], source, file)[0]!;
    const execute = vi.fn(async (_id: string, _command: string, input: () => unknown) => {
      useSsh.setState({ sessions: [] });
      expect(() => input()).toThrow(i18n.t("ssh.sessionMissing"));
      return {};
    });
    usePlugins.setState({ execute });
    await runFileMenuCommand(action, source, file);
    expect(execute).toHaveBeenCalledOnce();
  });
  it("rejects plugin replacement during the permission prompt before building input", async () => {
    const action = fileMenuCommands([contribution], source, file)[0]!;
    const execute = vi.fn(async (_id: string, _command: string, input: () => unknown) => {
      usePlugins.setState({ items: [{ ...contribution, fingerprint: "replacement" }] });
      expect(() => input()).toThrow(i18n.t("pluginSecurity.changed"));
      return {};
    });
    usePlugins.setState({ execute });
    await runFileMenuCommand(action, source, file);
    expect(execute).toHaveBeenCalledOnce();
  });
  it("discards command output when the plugin is replaced during execution", async () => {
    const openPluginView = vi.fn();
    useWorkspace.setState({ openPluginView });
    usePlugins.setState({
      outputs: {},
      execute: vi.fn(async () => {
        usePlugins.setState({ items: [{ ...contribution, fingerprint: "replacement" }] });
        return { text: "stale" };
      }),
    });
    await runFileMenuCommand(fileMenuCommands([contribution], source, file)[0]!, source, file);
    expect(openPluginView).not.toHaveBeenCalled();
    expect(usePlugins.getState().outputs[contribution.id]).toBeUndefined();
  });
  it("preserves long command output and reports the plugin's error state", async () => {
    const text = "x".repeat(140 * 1024);
    const openPluginView = vi.fn();
    useWorkspace.setState({ openPluginView });
    usePlugins.setState({ execute: vi.fn().mockResolvedValue({ text, error: true }) });
    await runFileMenuCommand(fileMenuCommands([contribution], source, file)[0]!, source, file);
    expect(usePlugins.getState().outputs[contribution.id]).toEqual({ text, error: true });
    expect(openPluginView).toHaveBeenCalledOnce();
  });
  it("reports oversized UTF-8 results without opening a truncated output", async () => {
    const openPluginView = vi.fn();
    useWorkspace.setState({ openPluginView });
    usePlugins.setState({ execute: vi.fn().mockResolvedValue({ text: "中".repeat(350_000) }) });
    await runFileMenuCommand(fileMenuCommands([contribution], source, file)[0]!, source, file);
    expect(openPluginView).not.toHaveBeenCalled();
    expect(useToasts.getState().items.at(-1)).toMatchObject({
      variant: "error",
      message: i18n.t("pluginView.resultTooLarge"),
    });
  });
});
