import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import Ajv from "ajv";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { runPluginWorkspaceRequest } from "@/app/pluginWorkspaceBridge";
import { useDialogs } from "@/store/dialogs";
import { usePlugins } from "@/store/plugins";
import type { PluginInfo } from "@/lib/api/types";
import floor from "../fixtures/plugin-compat/ui-v1.json";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), toast: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@/store/toasts", () => ({ toast: mocks.toast }));
vi.mock("@/i18n/i18n", () => ({
  default: { t: (_key: string, values?: { name?: string }) => values?.name ?? "Confirm" },
}));
const ajv = new Ajv({ allErrors: true });
const samples: Record<string, unknown>[] = [];
async function call(
  method: keyof typeof floor.methods,
  params: Record<string, unknown>,
  signal?: AbortSignal,
) {
  const contract = floor.methods[method];
  const sample: Record<string, unknown> = {
    method,
    params,
    inputValid: ajv.validate(contract.inputSchema, params),
  };
  try {
    const result = await runPluginWorkspaceRequest(
      { requestId: "ui-contract", pluginId: "ui-contract", method, params },
      signal,
    );
    expect(ajv.validate(contract.resultSchema, result)).toBe(true);
    sample.result = result;
    samples.push(sample);
    return result;
  } catch (error) {
    sample.frontendError = error instanceof Error ? error.message : String(error);
    samples.push(sample);
    throw error;
  }
}
const settle = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};
beforeEach(() => {
  vi.useFakeTimers();
  mocks.invoke.mockReset().mockResolvedValue(undefined);
  mocks.toast.mockReset();
  useDialogs.getState().close();
  usePlugins.setState({
    items: [{ id: "ui-contract", name: "Installed extension" } as PluginInfo],
  });
});
afterEach(() => {
  useDialogs.getState().close();
  vi.useRealTimers();
});

it("preserves notification kinds, defaults, identity and literal text with null result", async () => {
  for (const kind of [undefined, null, "info", "success", "error"]) {
    const params = {
      message: "<strong>plain</strong>\n消息",
      ...(kind === undefined ? {} : { kind }),
      future: true,
      pluginId: "forged",
    };
    expect(await call("ui.showMessage", params)).toBe(null);
    expect(mocks.toast).toHaveBeenLastCalledWith(
      "Installed extension: <strong>plain</strong>\n消息",
      kind ?? "info",
    );
  }
  expect(await call("ui.showMessage", { message: "x".repeat(4000) })).toBe(null);
  expect(await call("ui.showMessage", { message: "😀".repeat(2000) })).toBe(null);
});

it("rejects malformed messages and kinds before producing visible UI", async () => {
  for (const message of [
    undefined,
    null,
    false,
    1,
    "",
    "bad\0message",
    "x".repeat(4001),
    "😀".repeat(2001),
  ]) {
    await expect(call("ui.showMessage", { message })).rejects.toThrow("invalid:message");
  }
  for (const kind of ["", "warn", "INFO", false, 1])
    await expect(call("ui.showMessage", { message: "ok", kind })).rejects.toThrow("invalid:kind");
  expect(mocks.toast).not.toHaveBeenCalled();
});

it("requires an explicit confirmation and otherwise returns false", async () => {
  for (const action of ["confirm", "dismiss", "replace", "timeout"] as const) {
    const pending = call("ui.confirm", { message: "Review\n<plain text>", future: true });
    await settle();
    const dialog = useDialogs.getState().dialog;
    expect(dialog).toMatchObject({
      kind: "confirm",
      title: "Installed extension",
      body: "Review\n<plain text>",
      preformatted: true,
    });
    if (dialog.kind !== "confirm") throw new Error("missing dialog");
    if (action === "confirm") {
      dialog.onConfirm();
      useDialogs.getState().close();
    }
    if (action === "dismiss") useDialogs.getState().close();
    if (action === "replace") useDialogs.getState().openHost();
    if (action === "timeout") await vi.advanceTimersByTimeAsync(55_000);
    expect(await pending).toBe(action === "confirm");
    if (action === "replace") expect(useDialogs.getState().dialog.kind).toBe("host");
    useDialogs.getState().close();
  }
});

it("preserves large confirmations and validates their independent boundary", async () => {
  for (const message of ["x".repeat(220 * 1024), "😀".repeat(110 * 1024)]) {
    const pending = call("ui.confirm", { message });
    await settle();
    expect(useDialogs.getState().dialog).toMatchObject({ body: message });
    useDialogs.getState().close();
    expect(await pending).toBe(false);
  }
  for (const message of [null, "", "\0", "x".repeat(220 * 1024 + 1), "😀".repeat(110 * 1024 + 1)])
    await expect(call("ui.confirm", { message })).rejects.toThrow("invalid:message");
});

it("rejects a busy dialog and cancelled request without replacing user UI", async () => {
  useDialogs.getState().openHost();
  await expect(call("ui.confirm", { message: "Continue?" })).rejects.toThrow("dialog.busy");
  const controller = new AbortController();
  controller.abort();
  await expect(call("ui.confirm", { message: "Continue?" }, controller.signal)).rejects.toThrow(
    "requestCancelled",
  );
  expect(useDialogs.getState().dialog.kind).toBe("host");
});

afterAll(() => {
  const path = process.env.TUNNELDE_UI_CONTRACT_OUTPUT;
  if (path) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ samples }));
  }
});
