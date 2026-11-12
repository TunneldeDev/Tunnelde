import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import Ajv from "ajv";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import { runPluginWorkspaceRequest } from "@/app/pluginWorkspaceBridge";
import { mountFilePreview } from "@/lib/files/preview/registry";
import type { FilePreviewContext } from "@/lib/extensions/files/preview/context";
import type { FilePreviewMetadata } from "@/lib/extensions/contracts/files/preview/data";
import { useFilePreview } from "@/store/filePreview";
import schema from "../../src-tauri/src/plugins/api/domains/files/preview/schema.json";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(async () => undefined) }));
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
const registrations: ReturnType<typeof mountFilePreview>[] = [];
const identity = { id: "preview-one", revision: "frame-one" };
function prepare(change: Partial<FilePreviewMetadata> = {}) {
  const snapshot: FilePreviewMetadata = {
    ...identity,
    attemptId: "attempt-one",
    source: { kind: "remote", sessionId: "peer" },
    path: "/资料/a.png",
    line: 0,
    column: 0,
    presentation: "quickLook",
    renderer: "image",
    providerId: "preview:images",
    providerCount: 1,
    state: "loading",
    errorCode: null,
    ...change,
  };
  const mounted = mountFilePreview(snapshot.id);
  registrations.push(mounted);
  const actions = { close: vi.fn(), retry: vi.fn(), selectProvider: vi.fn() };
  const context: FilePreviewContext = {
    snapshot,
    ...actions,
    validate: () => {},
    validateTarget: () => {},
    readProviders: ({ offset = 0 }) => ({
      schemaVersion: 1,
      id: snapshot.id,
      revision: snapshot.revision,
      total: 1,
      offset,
      nextOffset: null,
      items: offset === 0 ? [{ id: "preview:images", name: "图像", renderer: "image" }] : [],
    }),
  };
  mounted.publish(context);
  return { mounted, context, actions };
}
async function call(method: Method, params: Record<string, unknown> = {}) {
  expect(validators[method]!.input(params), JSON.stringify(validators[method]!.input.errors)).toBe(
    true,
  );
  const result = await runPluginWorkspaceRequest({
    method,
    params,
    requestId: "preview-contract",
    pluginId: "preview-probe",
  });
  expect(
    validators[method]!.result(result),
    JSON.stringify(validators[method]!.result.errors),
  ).toBe(true);
  samples.push({ method, params, result });
  return result;
}
afterEach(() => {
  for (const mounted of registrations.splice(0)) mounted.dispose();
  useFilePreview.getState().close();
  mocks.invoke.mockReset().mockResolvedValue(undefined);
});
it("projects real host metadata, conditional/null observation, providers and accepted actions through schemas", async () => {
  await call("filePreview.observe");
  const { mounted, context, actions } = prepare();
  const first = (await call("filePreview.observe")) as { revision: string };
  await call("filePreview.observe", { revision: first.revision });
  await call("filePreview.providers", identity);
  await call("filePreview.providers", { ...identity, offset: 1 });
  for (const action of ["close", "retry", "selectProvider"])
    await call("filePreview.action", {
      ...identity,
      action,
      ...(action === "selectProvider" ? { providerId: "preview:images" } : {}),
    });
  expect(actions.selectProvider).toHaveBeenCalledWith("preview:images");
  for (const state of ["ready", "error", "unavailable"] as const) {
    const snapshot = {
      ...context.snapshot,
      revision: state,
      state,
      errorCode:
        state === "error"
          ? ("decodeFailed" as const)
          : state === "unavailable"
            ? ("rendererUnavailable" as const)
            : null,
      ...(state === "unavailable" ? { providerId: null, providerCount: 0 } : {}),
    };
    mounted.publish({ ...context, snapshot });
    await call("filePreview.observe");
  }
  for (const source of [
    { kind: "local" } as const,
    { kind: "remote", sessionId: "explicit" } as const,
  ])
    await call("filePreview.open", {
      source,
      path: source.kind === "local" ? "C:/a.txt" : "/a.txt",
      line: 2,
      column: 3,
    });
});
it("checks live native authorization and cancellation immediately before commit", async () => {
  const { actions } = prepare();
  const request = {
    method: "filePreview.action",
    params: { ...identity, action: "close" },
    requestId: "revoked",
    pluginId: "probe",
  };
  const cancelled = new AbortController();
  cancelled.abort();
  await expect(runPluginWorkspaceRequest(request, cancelled.signal)).rejects.toThrow(
    "requestCancelled",
  );
  expect(mocks.invoke).not.toHaveBeenCalled();
  mocks.invoke
    .mockResolvedValueOnce(undefined)
    .mockRejectedValueOnce(new Error("read permission revoked"));
  await expect(runPluginWorkspaceRequest(request)).rejects.toThrow("read permission revoked");
  const delayed = new AbortController();
  mocks.invoke
    .mockReset()
    .mockResolvedValueOnce(undefined)
    .mockImplementationOnce(async () => {
      delayed.abort();
      return undefined;
    });
  await expect(runPluginWorkspaceRequest(request, delayed.signal)).rejects.toThrow(
    "requestCancelled",
  );
  expect(actions.close).not.toHaveBeenCalled();
});
it("rejects malformed parameters and excessive serialized metadata without reading or changing targets", async () => {
  prepare({ path: "/" + "\n".repeat(50000) });
  await expect(call("filePreview.observe")).rejects.toThrow("invalid");
  for (const params of [
    null,
    [],
    { revision: null },
    {
      get revision() {
        throw Error("getter executed");
      },
    },
    { [Symbol()]: true },
  ])
    await expect(
      runPluginWorkspaceRequest({
        method: "filePreview.observe",
        params: params as Record<string, unknown>,
        requestId: "x",
        pluginId: "probe",
      }),
    ).rejects.toThrow("invalid");
});
afterAll(() => {
  const path = process.env.TUNNELDE_FILE_PREVIEW_CONTRACT_OUTPUT;
  if (path) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ samples }));
  }
});
