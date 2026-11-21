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
  createDeclarativeViewOwner,
  type DeclarativeFormRequest,
} from "@/lib/plugins/views/declarative";
import { usePlugins } from "@/store/plugins";
const payload = () => ({
  title: "Tool",
  blocks: [
    {
      type: "form",
      id: "form",
      fields: [
        { id: "text", type: "text", label: "Text", value: "initial" },
        {
          id: "mode",
          type: "select",
          label: "Mode",
          value: "a",
          options: [{ value: "a", label: "A" }],
        },
      ],
      actions: [{ id: "save", label: "Save", command: "actual-command" }],
    },
  ],
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const request = (
  revision: string,
  values: Record<string, string> = {},
): DeclarativeFormRequest => ({
  revision,
  formId: "form",
  actionId: "save",
  values,
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
describe("declarative view execution ownership", () => {
  it("constructs without activation and resolves command/fields from its private display snapshot", async () => {
    const owner = createDeclarativeViewOwner(plugin.id, "main");
    expect(mocks.render).not.toHaveBeenCalled();
    expect(mocks.run).not.toHaveBeenCalled();
    const display = (await owner.load("en-US"))!;
    expect(mocks.render).toHaveBeenCalledWith(plugin.id, "main", "en-US", "boot:1");
    const form = display.blocks[0]!;
    if (form.type !== "form") throw new Error("fixture");
    form.actions[0]!.command = "forged-command";
    form.fields[0]!.value = "forged-default";
    const result = await owner.run(
      request(display.revision, { text: "draft", extra: "discard", _locale: "forged" }),
    );
    expect(result).toEqual({ text: "Done", title: "", error: false });
    expect(mocks.run).toHaveBeenCalledExactlyOnceWith(
      plugin.id,
      "actual-command",
      {
        text: "draft",
        mode: "a",
        _locale: "en-US",
      },
      "boot:1",
    );
    owner.dispose();
  });
  it("rejects forged and retired display targets before consent or dispatch", async () => {
    const owner = createDeclarativeViewOwner(plugin.id, "main");
    const first = (await owner.load("en-US"))!;
    const second = (await owner.load("en-US"))!;
    for (const value of [
      request(first.revision),
      { ...request(second.revision), formId: "missing" },
      { ...request(second.revision), actionId: "missing" },
    ])
      await expect(owner.run(value)).rejects.toThrow();
    expect(mocks.authorize).not.toHaveBeenCalled();
    expect(mocks.run).not.toHaveBeenCalled();
    owner.dispose();
  });
  it("bounds and validates form input in the owner before requesting permission", async () => {
    const owner = createDeclarativeViewOwner(plugin.id, "main");
    const display = (await owner.load("en-US"))!;
    await expect(owner.run(request(display.revision, { mode: "not-an-option" }))).rejects.toThrow();
    await expect(
      owner.run(request(display.revision, { text: "中".repeat(90000) })),
    ).rejects.toThrow("inputTooLarge");
    await expect(
      owner.run({ ...request(display.revision), locale: null } as never),
    ).rejects.toThrow();
    expect(mocks.authorize).not.toHaveBeenCalled();
    expect(mocks.run).not.toHaveBeenCalled();
    owner.dispose();
  });
  it("never retargets an old owner to a restarted same-package runtime", async () => {
    const owner = createDeclarativeViewOwner(plugin.id, "main");
    const display = (await owner.load("en-US"))!;
    usePlugins.setState({ items: [{ ...plugin, status: "running", runtimeId: "boot:2" }] });
    await expect(owner.run(request(display.revision))).rejects.toThrow(
      "plugin.invocation.cancelled",
    );
    await expect(owner.load("en-US")).rejects.toThrow("plugin.invocation.cancelled");
    expect(mocks.render).toHaveBeenCalledTimes(1);
    expect(mocks.run).not.toHaveBeenCalled();
    owner.dispose();
  });
  it("cancels approval on refresh and cannot dispatch its retired command after late approval", async () => {
    const approval = deferred<boolean>();
    mocks.authorize.mockReturnValueOnce(approval.promise);
    const owner = createDeclarativeViewOwner(plugin.id, "main");
    const display = (await owner.load("en-US"))!;
    const run = owner.run(request(display.revision));
    const denied = expect(run).rejects.toThrow("plugin.invocation.cancelled");
    const signal = mocks.authorize.mock.calls[0]![1] as AbortSignal;
    await owner.load("en-US");
    expect(signal.aborted).toBe(true);
    approval.resolve(true);
    await denied;
    expect(mocks.run).not.toHaveBeenCalled();
    owner.dispose();
  });
  it("preserves the displayed incarnation when refresh consent is denied", async () => {
    const owner = createDeclarativeViewOwner(plugin.id, "main");
    const display = (await owner.load("en-US"))!;
    mocks.authorize.mockResolvedValueOnce(false);
    expect(await owner.load("en-US", { interactive: true })).toBeNull();
    await expect(owner.run(request(display.revision))).resolves.toMatchObject({ text: "Done" });
    expect(mocks.render).toHaveBeenCalledTimes(1);
    owner.dispose();
  });
  it("cancels displaced renders and ignores their late payload rather than publishing them", async () => {
    const late = deferred<unknown>();
    mocks.render.mockReturnValueOnce(late.promise);
    const owner = createDeclarativeViewOwner(plugin.id, "main");
    const first = owner.load("en-US");
    const failed = expect(first).rejects.toThrow("plugin.invocation.cancelled");
    const display = (await owner.load("en-US"))!;
    late.resolve({ blocks: [] });
    await failed;
    await expect(owner.run(request(display.revision))).resolves.toMatchObject({ text: "Done" });
    owner.dispose();
  });
  it("serializes a form, drops late results after refresh, and does not replay dispatched effects", async () => {
    const late = deferred<unknown>();
    mocks.run.mockReturnValueOnce(late.promise);
    const owner = createDeclarativeViewOwner(plugin.id, "main");
    const display = (await owner.load("en-US"))!;
    const first = owner.run(request(display.revision));
    const failed = expect(first).rejects.toThrow("plugin.invocation.cancelled");
    await expect(owner.run(request(display.revision))).rejects.toThrow("plugin.busy");
    expect(mocks.run).toHaveBeenCalledTimes(1);
    const next = (await owner.load("en-US"))!;
    await failed;
    late.resolve({ text: "stale" });
    await expect(owner.run(request(next.revision))).resolves.toMatchObject({ text: "Done" });
    expect(mocks.run).toHaveBeenCalledTimes(2);
    owner.dispose();
  });
  it("disposes approval and render waiters without accepting late replies", async () => {
    const approval = deferred<boolean>();
    mocks.authorize.mockReturnValueOnce(approval.promise);
    const owner = createDeclarativeViewOwner(plugin.id, "main");
    const display = (await owner.load("en-US"))!;
    const run = owner.run(request(display.revision));
    const failed = expect(run).rejects.toThrow("plugin.invocation.cancelled");
    owner.dispose();
    approval.resolve(true);
    await failed;
    await expect(owner.load("en-US")).rejects.toThrow("plugin.invocation.cancelled");
    expect(mocks.run).not.toHaveBeenCalled();
    const late = deferred<unknown>();
    mocks.render.mockReturnValueOnce(late.promise);
    const other = createDeclarativeViewOwner(plugin.id, "main");
    const loading = other.load("en-US");
    const cancelled = expect(loading).rejects.toThrow("plugin.invocation.cancelled");
    other.dispose();
    late.resolve(payload());
    await cancelled;
  });
  it("reports command failures once and permits an explicit subsequent action without losing the owner", async () => {
    const owner = createDeclarativeViewOwner(plugin.id, "main");
    const display = (await owner.load("en-US"))!;
    mocks.run.mockRejectedValueOnce(new Error("domain failure"));
    await expect(owner.run(request(display.revision))).rejects.toThrow("domain failure");
    expect(mocks.run).toHaveBeenCalledTimes(1);
    await owner.run(request(display.revision));
    expect(mocks.run).toHaveBeenCalledTimes(2);
    owner.dispose();
  });
});
