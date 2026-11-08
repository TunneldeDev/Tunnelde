import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import Ajv from "ajv";
import { checkCoreContracts } from "./check-core-contract.mjs";

const floor = JSON.parse(
  await readFile(
    new URL("../../tests/fixtures/plugin-compat/core-v1.json", import.meta.url),
    "utf8",
  ),
);
const ajv = new Ajv({ allErrors: true });
const clone = (value) => JSON.parse(JSON.stringify(value));
const editor = JSON.parse(
  await readFile(
    new URL("../../tests/fixtures/plugin-compat/editor-v1.json", import.meta.url),
    "utf8",
  ),
);

test("editor contract preserves document identity and allows forward-compatible fields", () => {
  const active = ajv.compile(editor.methods["editor.active"].resultSchema);
  const write = ajv.compile(editor.methods["editor.replace"].resultSchema);
  const document = {
    tabId: "editor-one",
    documentId: "document-one",
    version: 1,
    path: "/资料/a.json",
    name: "a.json",
    content: "",
    dirty: false,
  };
  assert.ok(active(null));
  assert.ok(active({ ...document, future: true }));
  const result = {
    tabId: document.tabId,
    documentId: document.documentId,
    version: 1,
    dirty: false,
  };
  assert.ok(write({ ...result, future: true }));
  for (const [validate, sample] of [
    [active, document],
    [write, result],
  ]) {
    for (const key of Object.keys(sample)) {
      const missing = { ...sample };
      delete missing[key];
      assert.equal(validate(missing), false, key);
    }
    for (const version of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1])
      assert.equal(validate({ ...sample, version }), false);
  }
  const request = ajv.compile(editor.methods["editor.replace"].inputSchema);
  const params = { tabId: "e", documentId: "d", version: 0, text: "" };
  assert.ok(request({ ...params, future: true }));
  assert.equal(request({ ...params, tabId: "x\0y" }), false);
  assert.equal(request({ ...params, documentId: "" }), false);
  assert.equal(request({ ...params, text: null }), false);
  // Character-count validity cannot establish the independent UTF-8 byte quota.
  assert.ok(request({ ...params, text: "中".repeat(43691) }));
});

test("storage schemas match ASCII keys, required fields and arbitrary JSON values", () => {
  const get = ajv.compile(floor.methods["storage.get"].inputSchema);
  const set = ajv.compile(floor.methods["storage.set"].inputSchema);
  for (const key of ["draft.v1-2_3", "a".repeat(128), "._-"]) {
    assert.ok(get({ key }));
    assert.ok(set({ key, value: null, future: true }));
  }
  for (const key of [
    "",
    "a\n",
    "a\r",
    "a\u2028",
    "键",
    "a".repeat(129),
    "../x",
    "__proto__",
    "prototype",
    "constructor",
    null,
    42,
  ]) {
    assert.equal(get({ key }), false, JSON.stringify(key));
    assert.equal(set({ key, value: null }), false, JSON.stringify(key));
  }
  assert.equal(set({ key: "draft" }), false);
  for (const value of [null, false, 0, "", [], {}, { nested: ["你好"] }])
    assert.ok(set({ key: "draft", value }));
});

test("session result preserves required fields but permits future additions", () => {
  const validate = ajv.compile(floor.methods["sessions.list"].resultSchema);
  const session = {
    id: "s",
    hostId: "h",
    title: "Example",
    address: "host:22",
    cols: 80,
    rows: 24,
    connectedAt: 123,
  };
  assert.ok(validate([]));
  assert.ok(validate([{ ...session, future: true }]));
  for (const field of Object.keys(session)) {
    const missing = { ...session };
    delete missing[field];
    assert.equal(validate([missing]), false, field);
  }
  assert.equal(validate([{ ...session, cols: -1 }]), false);
  assert.equal(validate([{ ...session, rows: 1.5 }]), false);
  assert.equal(validate([{ ...session, hostId: null }]), false);
});

test("contract gate detects removed methods, narrowed schemas, permissions and invalid host results", () => {
  const discovery = {
    methods: Object.entries(floor.methods).map(([name, contract]) => ({
      name,
      contract,
      stability: "stable",
      since: "0.21.0",
      permissions: name === "sessions.list" ? ["sessions.read"] : [],
    })),
  };
  const results = {
    "api.describe": { version: 1, methods: [] },
    "sessions.list": [],
    "storage.get": null,
    "storage.set": null,
    "storage.delete": null,
  };
  const responses = {
    samples: Object.keys(floor.methods).flatMap((method) => {
      const params =
        method === "storage.set"
          ? { key: "draft", value: null }
          : method.startsWith("storage.")
            ? { key: "draft" }
            : {};
      return [
        { method, params, result: results[method] },
        {
          method,
          params,
          error: { code: -32001, message: "pluginSecurity.blocked", data: { code: "validation" } },
        },
      ];
    }),
  };
  assert.deepEqual(checkCoreContracts(discovery, responses, floor), { methods: 5, samples: 10 });
  for (const mutate of [
    (d) => d.methods.pop(),
    (d) => {
      d.methods[0].stability = "experimental";
    },
    (d) => {
      d.methods[0].contract.inputSchema.additionalProperties = false;
    },
    (d) => {
      d.methods[1].permissions = [];
    },
  ]) {
    const copy = clone(discovery);
    mutate(copy);
    assert.throws(() => checkCoreContracts(copy, responses, floor));
  }
  const wrong = clone(responses);
  wrong.samples.find((sample) => sample.method === "storage.set").result = {};
  assert.throws(() => checkCoreContracts(discovery, wrong, floor));
  const missing = clone(responses);
  delete missing.samples[1].error.message;
  assert.throws(() => checkCoreContracts(discovery, missing, floor));
  const additions = clone(responses);
  additions.samples[0].result.future = true;
  additions.samples[1].error.future = true;
  assert.doesNotThrow(() => checkCoreContracts(discovery, additions, floor));
});
