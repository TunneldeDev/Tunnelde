import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import Ajv from "ajv";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { runPluginWorkspaceRequest } from "@/app/pluginWorkspaceBridge";
import { createFileBrowserContext } from "@/lib/extensions/files/context";
import { mountFileBrowser } from "@/lib/files/browser/registry";
import schema from "../../src-tauri/src/plugins/api/domains/files/browser/schema.json";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
type Method = keyof typeof schema.methods;
const ajv = new Ajv({ allErrors: true });
const validators = Object.fromEntries(
  Object.entries(schema.methods).map(([method, shapes]) => [
    method,
    {
      input: ajv.compile({ definitions: schema.definitions, ...shapes.inputSchema }),
      result: ajv.compile({ definitions: schema.definitions, ...shapes.resultSchema }),
    },
  ]),
);
const samples: { method: Method; params: Record<string, unknown>; result: unknown }[] = [];
const registrations: ReturnType<typeof mountFileBrowser>[] = [];
const actions = { refresh: vi.fn(), navigate: vi.fn(), select: vi.fn(), open: vi.fn() };
const id = { paneId: "contract-browser", revision: "frame-1" };

function prepare(count = 300, long = false) {
  const mounted = mountFileBrowser(id.paneId);
  registrations.push(mounted);
  const entries = Array.from({ length: count }, (_, i) => ({
    name: `${i}${long ? "名".repeat(1000) : ".txt"}`,
    path: `/资料/${i}${long ? "路".repeat(700) : ".txt"}`,
    isDir: i === 0,
    isHidden: false,
    size: i,
    modified: i === 0 ? -1 : null,
    permissions: 0o644,
  }));
  mounted.publish({
    tabId: "files-tab",
    suspended: false,
    browser: createFileBrowserContext(
      {
        ...id,
        source: { kind: "remote", sessionId: "remote-one" },
        path: "/资料",
        total: count,
        selectedPaths: entries.slice(0, 2).map((e) => e.path),
        busy: false,
        error: null,
      },
      entries,
      () => {},
      actions,
    ),
  });
  return { mounted, entries };
}
async function call(method: Method, params: Record<string, unknown> = {}) {
  expect(validators[method]!.input(params), JSON.stringify(validators[method]!.input.errors)).toBe(
    true,
  );
  const result = await runPluginWorkspaceRequest({
    method,
    params,
    requestId: "browser-request",
    pluginId: "browser-probe",
  });
  expect(
    validators[method]!.result(result),
    JSON.stringify(validators[method]!.result.errors),
  ).toBe(true);
  samples.push({ method, params, result });
  return result;
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.invoke.mockResolvedValue(undefined);
});
afterEach(() => {
  for (const mounted of registrations.splice(0)) mounted.dispose();
});

it("serializes real committed metadata, conditional replies, ordered pages and all host actions", async () => {
  const { entries } = prepare();
  const observed = (await call("fileBrowser.observe", { limit: 1 })) as { revision: string };
  await call("fileBrowser.observe", { limit: 1, revision: observed.revision });
  await call("fileBrowser.read", { ...id, limit: 64 });
  await call("fileBrowser.read", { ...id, offset: 290 });
  await call("fileBrowser.read", { ...id, offset: 300 });
  for (const request of [
    { ...id, action: "refresh" },
    { ...id, action: "navigate", path: "/next" },
    { ...id, action: "select", paths: [entries[1]!.path] },
    { ...id, action: "open", path: entries[1]!.path, mode: "preview" },
    { ...id, action: "open", path: entries[0]!.path },
  ])
    await call("fileBrowser.action", request);
  expect(actions.open).toHaveBeenCalledWith(
    expect.objectContaining({ path: entries[1]!.path }),
    true,
  );
  expect(actions.navigate).toHaveBeenLastCalledWith(entries[0]!.path);
});

it("emits byte-limited multibyte pages accepted by the actual schema", async () => {
  prepare(200, true);
  const result = (await call("fileBrowser.read", { ...id, limit: 256 })) as {
    items: unknown[];
    nextOffset: number;
  };
  expect(result.items.length).toBeLessThan(200);
  expect(result.items.length).toBeGreaterThan(0);
  expect(result.nextOffset).toBe(result.items.length);
  expect(new TextEncoder().encode(JSON.stringify(result)).length).toBeLessThanOrEqual(65536);
});

it("checks cancellation and live authorization on the real bridge before dispatch", async () => {
  prepare();
  const request = {
    method: "fileBrowser.action",
    params: { ...id, action: "refresh" },
    requestId: "revoked",
    pluginId: "probe",
  };
  const controller = new AbortController();
  controller.abort();
  await expect(runPluginWorkspaceRequest(request, controller.signal)).rejects.toThrow(
    "requestCancelled",
  );
  expect(mocks.invoke).not.toHaveBeenCalled();
  mocks.invoke
    .mockResolvedValueOnce(undefined)
    .mockRejectedValueOnce(new Error("permission revoked"));
  await expect(runPluginWorkspaceRequest(request)).rejects.toThrow("permission revoked");
  expect(actions.refresh).not.toHaveBeenCalled();
  const next = new AbortController();
  mocks.invoke
    .mockReset()
    .mockResolvedValueOnce(undefined)
    .mockImplementationOnce(async () => next.abort());
  await expect(runPluginWorkspaceRequest(request, next.signal)).rejects.toThrow("requestCancelled");
  expect(actions.refresh).not.toHaveBeenCalled();
});

afterAll(() => {
  const path = process.env.TUNNELDE_FILE_BROWSER_CONTRACT_OUTPUT;
  if (path) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ samples }));
  }
});
