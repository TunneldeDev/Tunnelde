import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import Ajv from "ajv";
import { afterAll, beforeEach, expect, it, vi } from "vitest";
import { runPluginWorkspaceRequest } from "@/app/pluginWorkspaceBridge";
import { useEditors, undoEditorEdit } from "@/store/editors";
import { useWorkspace } from "@/store/workspace";
import type { PluginEditorDocument, PluginEditorWriteResult } from "@/lib/plugins/editor";
import floor from "../fixtures/plugin-compat/editor-v1.json";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), write: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@/lib/api/ipc", () => ({
  api: { localWriteText: mocks.write, sftpWriteText: mocks.write },
}));

type Sample = {
  method: string;
  params: Record<string, unknown>;
  inputValid: boolean;
  result?: unknown;
  frontendError?: string;
};
const samples: Sample[] = [];
const ajv = new Ajv({ allErrors: true });
const methods = {
  "editor.active": {
    input: ajv.compile(floor.methods["editor.active"].inputSchema),
    result: ajv.compile(floor.methods["editor.active"].resultSchema),
  },
  "editor.replace": {
    input: ajv.compile(floor.methods["editor.replace"].inputSchema),
    result: ajv.compile(floor.methods["editor.replace"].resultSchema),
  },
};

async function call(
  method: keyof typeof methods,
  params: Record<string, unknown> = {},
  inputValid = true,
) {
  expect(methods[method].input(params)).toBe(inputValid);
  const sample: Sample = { method, params, inputValid };
  try {
    sample.result = await runPluginWorkspaceRequest({
      requestId: "editor-contract-request",
      pluginId: "editor-contract-probe",
      method,
      params,
    });
    expect(
      methods[method].result(sample.result),
      JSON.stringify(methods[method].result.errors),
    ).toBe(true);
    samples.push(sample);
    return sample.result;
  } catch (error) {
    sample.frontendError = error instanceof Error ? error.message : String(error);
    if (!sample.frontendError.startsWith("pluginSecurity.")) samples.push(sample);
    throw error;
  }
}

function prepare(content = '{"值":1}') {
  useEditors.getState().discard("editor-contract");
  useEditors.setState({
    entries: {
      "editor-contract": {
        tabId: "editor-contract",
        documentId: "document-v1",
        version: 0,
        sessionId: "private-transport",
        path: "/资料/data.json",
        name: "data.json",
        content,
        baseline: content,
        loading: false,
        saving: false,
        error: null,
      },
    },
  });
  useWorkspace.setState({ activeId: "editor-contract" });
}
const read = () => call("editor.active") as Promise<PluginEditorDocument | null>;
const replace = (document: PluginEditorDocument, text: string) =>
  call("editor.replace", {
    tabId: document.tabId,
    documentId: document.documentId,
    version: document.version,
    text,
  }) as Promise<PluginEditorWriteResult>;

beforeEach(() => {
  mocks.invoke.mockReset().mockResolvedValue(undefined);
  mocks.write.mockReset();
  prepare();
});

it("emits projected snapshots and writes with compare-and-swap, no-op and undo semantics", async () => {
  const document = (await call("editor.active", { future: true })) as PluginEditorDocument;
  expect(Object.keys(document).sort()).toEqual(
    ["tabId", "documentId", "version", "path", "name", "content", "dirty"].sort(),
  );
  expect(await replace(document, document.content)).toEqual({
    tabId: document.tabId,
    documentId: document.documentId,
    version: 0,
    dirty: false,
  });
  const changed = await replace(document, "");
  expect(changed).toEqual({
    tabId: document.tabId,
    documentId: document.documentId,
    version: 1,
    dirty: true,
  });
  await expect(replace(document, "stale")).rejects.toThrow("editor.documentChanged");
  expect(undoEditorEdit(document.tabId)).toBe(true);
  const undone = (await read())!;
  expect(undone.content).toBe(document.content);
  expect(undone.version).toBeGreaterThan(changed.version);
  expect(undoEditorEdit(document.tabId, true)).toBe(true);
  expect((await read())!.content).toBe("");
  expect(mocks.write).not.toHaveBeenCalled();
});

it("does not expose future internal fields or mutable store state", async () => {
  const entry = useEditors.getState().entries["editor-contract"]!;
  useEditors.setState({
    entries: {
      "editor-contract": {
        ...entry,
        baseline: "private original",
        saveFailure: "internal diagnostics",
      },
    },
  });
  const document = (await read())!;
  expect(document).not.toHaveProperty("baseline");
  expect(document).not.toHaveProperty("sessionId");
  expect(document).not.toHaveProperty("saveFailure");
  document.content = "changed by consumer";
  expect(useEditors.getState().entries[document.tabId]!.content).toBe(entry.content);
});

it("returns null for non-editors and unavailable buffers, and refuses their writes", async () => {
  const document = (await read())!;
  for (const state of [{ loading: true }, { error: "read failure" }, { disconnected: true }]) {
    prepare();
    const entry = useEditors.getState().entries[document.tabId]!;
    useEditors.setState({ entries: { [document.tabId]: { ...entry, ...state } } });
    expect(await read()).toBeNull();
    await expect(replace(document, "must not write")).rejects.toThrow("editor.documentChanged");
  }
  prepare();
  useWorkspace.setState({ activeId: "page:settings" });
  expect(await read()).toBeNull();
  useWorkspace.setState({ activeId: null });
  expect(await read()).toBeNull();
  useEditors.getState().discard(document.tabId);
  await expect(replace(document, "closed")).rejects.toThrow("editor.documentChanged");
});

it("checks UTF-8 byte limits separately from schema character lengths", async () => {
  for (const content of ["a".repeat(131072), "中".repeat(43690), "😀".repeat(32768)]) {
    prepare(content);
    const document = (await read())!;
    expect(document.content).toBe(content);
    expect(await replace(document, content)).toMatchObject({ version: 0, dirty: false });
  }
  prepare();
  const document = (await read())!;
  for (const text of ["中".repeat(43691), "😀".repeat(32769)])
    await expect(replace(document, text)).rejects.toThrow("invalid:text");
  useEditors.getState().change(document.tabId, "a".repeat(131073));
  await expect(read()).rejects.toThrow("editor.documentTooLarge");
});

it("rejects invalid identities, unsafe versions and non-text replacement values", async () => {
  const document = (await read())!;
  const valid = {
    tabId: document.tabId,
    documentId: document.documentId,
    version: document.version,
    text: "changed",
  };
  for (const key of ["tabId", "documentId"]) {
    for (const value of [undefined, null, 1, "", "bad\0id", "x".repeat(1025)])
      await expect(call("editor.replace", { ...valid, [key]: value }, false)).rejects.toThrow(
        `invalid:${key}`,
      );
  }
  for (const version of [undefined, null, -1, 0.1, "0", Number.MAX_SAFE_INTEGER + 1])
    await expect(call("editor.replace", { ...valid, version }, false)).rejects.toThrow(
      "invalid:version",
    );
  for (const text of [undefined, null, 1, "x".repeat(131073)])
    await expect(call("editor.replace", { ...valid, text }, false)).rejects.toThrow("invalid:text");
  expect(useEditors.getState().entries[document.tabId]!.content).toBe(document.content);
});

it("honors authorization before reading or writing and leaves the buffer intact", async () => {
  const document = (await read())!;
  mocks.invoke.mockRejectedValue(new Error("pluginSecurity.permissionDenied"));
  await expect(read()).rejects.toThrow("pluginSecurity.permissionDenied");
  await expect(replace(document, "unauthorized")).rejects.toThrow(
    "pluginSecurity.permissionDenied",
  );
  expect(useEditors.getState().entries[document.tabId]!.content).toBe(document.content);
});

afterAll(() => {
  // Rust's real frontend-reply and JSON-RPC error encoder consume these in CI.
  // They are generated by executing the bridge, not by reimplementing its output.
  const path = process.env.TUNNELDE_EDITOR_CONTRACT_OUTPUT;
  if (path) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ samples }));
  }
  useEditors.getState().discard("editor-contract");
});
