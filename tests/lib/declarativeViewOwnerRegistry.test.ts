import { beforeEach, describe, expect, it, vi } from "vitest";
import { plugin } from "../fixtures/plugins";

const mocks = vi.hoisted(() => ({
  render: vi.fn(),
  run: vi.fn(),
  authorize: vi.fn(),
  native: vi.fn(),
}));
vi.mock("@/lib/api/ipc", () => ({
  api: { pluginRenderView: mocks.render, pluginRun: mocks.run },
  isTauri: mocks.native,
}));
vi.mock("@/store/pluginSecurity", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  authorizePluginAction: mocks.authorize,
}));
import {
  acquireDeclarativeViewOwner,
  declarativeViewOwnerRegistrySize,
  installDeclarativeViewOwnerRegistry,
} from "@/lib/plugins/views/ownerRegistry";
import type { DeclarativeFormRequest } from "@/lib/plugins/views/declarative";
import { usePlugins } from "@/store/plugins";

const payload = () => ({
  blocks: [
    {
      type: "form",
      id: "form",
      fields: [{ id: "value", type: "text", label: "Value", value: "initial" }],
      actions: [{ id: "save", label: "Save", command: "actual-command" }],
    },
  ],
});
const request = (revision: string): DeclarativeFormRequest => ({
  revision,
  formId: "form",
  actionId: "save",
  values: { value: "draft" },
  locale: "en-US",
});

beforeEach(() => {
  mocks.render.mockReset().mockResolvedValue(payload());
  mocks.run.mockReset().mockResolvedValue({ text: "Done" });
  mocks.authorize.mockReset().mockResolvedValue(true);
  mocks.native.mockReturnValue(true);
  usePlugins.setState({
    items: [{ ...plugin, status: "running", runtimeId: "boot:1" }],
    stoppingIds: [],
  });
});

describe("declarative view owner registry", () => {
  it("retains the displayed incarnation across body unmount and remount", async () => {
    const stop = installDeclarativeViewOwnerRegistry();
    const first = acquireDeclarativeViewOwner(plugin.id, "main");
    const display = (await first.owner.load("en-US"))!;
    first.release();
    const second = acquireDeclarativeViewOwner(plugin.id, "main");
    expect(second.owner).toBe(first.owner);
    await expect(second.owner.run(request(display.revision))).resolves.toMatchObject({
      text: "Done",
    });
    expect(mocks.render).toHaveBeenCalledTimes(1);
    expect(mocks.run).toHaveBeenCalledTimes(1);
    second.release();
    stop();
    expect(declarativeViewOwnerRegistrySize()).toBe(0);
  });

  it("does not retain an owner when the coordinator registry is not installed", () => {
    const first = acquireDeclarativeViewOwner(plugin.id, "main");
    first.release();
    expect(declarativeViewOwnerRegistrySize()).toBe(0);
    const second = acquireDeclarativeViewOwner(plugin.id, "main");
    expect(second.owner).not.toBe(first.owner);
    second.release();
  });

  it("retires an idle owner immediately when the exact plugin runtime disappears", async () => {
    const stop = installDeclarativeViewOwnerRegistry();
    const lease = acquireDeclarativeViewOwner(plugin.id, "main");
    const display = (await lease.owner.load("en-US"))!;
    lease.release();
    usePlugins.setState({
      items: [{ ...plugin, status: "stopped", runtimeId: null }],
      stoppingIds: [],
    });
    expect(declarativeViewOwnerRegistrySize()).toBe(0);
    await expect(lease.owner.run(request(display.revision))).rejects.toThrow(
      "plugin.invocation.cancelled",
    );
    stop();
  });

  it("rejects acquisition for stopped or undeclared contributions", () => {
    const stop = installDeclarativeViewOwnerRegistry();
    usePlugins.setState({
      items: [{ ...plugin, status: "stopped", runtimeId: null }],
      stoppingIds: [],
    });
    expect(() => acquireDeclarativeViewOwner(plugin.id, "main")).toThrow("plugin.notRunning");
    stop();
  });

  it("cannot install a second coordinator registry over the live owner table", () => {
    const stop = installDeclarativeViewOwnerRegistry();
    expect(() => installDeclarativeViewOwnerRegistry()).toThrow(
      "plugin.declarativeOwner.alreadyInstalled",
    );
    stop();
  });
});

describe("declarative view owner snapshot", () => {
  it("returns a clone of the displayed incarnation without mutating the private action table", async () => {
    const stop = installDeclarativeViewOwnerRegistry();
    const lease = acquireDeclarativeViewOwner(plugin.id, "main");
    const display = (await lease.owner.load("en-US"))!;
    const snapshot = lease.owner.snapshot()!;
    expect(snapshot.revision).toBe(display.revision);
    const form = snapshot.blocks[0]!;
    if (form.type !== "form") throw new Error("fixture");
    form.actions[0]!.command = "forged";
    form.fields[0]!.value = "forged";
    await expect(lease.owner.run(request(display.revision))).resolves.toMatchObject({
      text: "Done",
    });
    expect(mocks.run).toHaveBeenCalledWith(
      plugin.id,
      "actual-command",
      { value: "draft", _locale: "en-US" },
      "boot:1",
    );
    lease.release();
    stop();
  });
});
