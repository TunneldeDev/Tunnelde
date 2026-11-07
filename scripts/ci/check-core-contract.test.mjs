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
