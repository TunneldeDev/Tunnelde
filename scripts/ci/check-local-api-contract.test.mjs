import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  checkLocalApiContract,
  checkProtocolSamples,
  contractValidator,
} from "./check-local-api-contract.mjs";

const floor = JSON.parse(
  await readFile(
    new URL("../../tests/fixtures/local-api/candidate-v1.json", import.meta.url),
    "utf8",
  ),
);
const fixture = () => ({
  schema: globalThis.structuredClone(floor),
  samples: [
    { method: "api.describe", params: {}, result: floor },
    {
      method: "app.info",
      params: {},
      result: { version: "1.0.0", apiVersion: 1, platform: "linux", architecture: "x86_64" },
    },
    { method: "hosts.list", params: {}, result: { hosts: [] } },
    { method: "sessions.list", params: {}, result: { sessions: [] } },
  ],
});
test("local API checker accepts a compatible client floor", () => {
  assert.deepEqual(checkLocalApiContract(fixture(), floor), { methods: 4, samples: 4 });
});
test("local API checker rejects removed fields and missing actual coverage", () => {
  const removed = fixture();
  delete removed.samples[1].result.apiVersion;
  assert.throws(() => checkLocalApiContract(removed, floor), /app.info/);
  const missing = fixture();
  missing.samples.pop();
  assert.throws(() => checkLocalApiContract(missing, floor), /actual producer sample/);
});
test("local API checker detects contract, transport and error changes", () => {
  const changed = fixture();
  changed.schema.methods[1].inputSchema.additionalProperties = true;
  assert.throws(() => checkLocalApiContract(changed, floor), /contract changed/);
  const transport = fixture();
  transport.schema.transport.maximumRequestBytes++;
  assert.throws(() => checkLocalApiContract(transport, floor), /transport changed/);
  const errors = fixture();
  errors.schema.errors.pop();
  assert.throws(() => checkLocalApiContract(errors, floor), /errors changed/);
});

test("decimal preference steps accept normal floats and reject half-step values", () => {
  const candidate = fixture();
  candidate.schema.methods[1].resultSchema.properties.lineHeight = {
    type: "number",
    multipleOf: 0.1,
  };
  const expected = globalThis.structuredClone(candidate.schema);
  candidate.samples[1].result.lineHeight = 1.2;
  assert.doesNotThrow(() => checkLocalApiContract(candidate, expected));
  candidate.samples[1].result.lineHeight = 1.25;
  assert.throws(() => checkLocalApiContract(candidate, expected), /multipleOf/);
});

const protocol = JSON.parse(
  await readFile(
    new URL("../../tests/fixtures/local-api/protocol-v1.json", import.meta.url),
    "utf8",
  ),
);

const discovery = JSON.parse(
  await readFile(
    new URL("../../tests/fixtures/local-api/discovery-v1.json", import.meta.url),
    "utf8",
  ),
);

function discoverableFixture() {
  const current = fixture();
  current.schema.protocol = globalThis.structuredClone(protocol);
  current.schema.methods[0].resultSchema = globalThis.structuredClone(discovery);
  current.samples[0].result = globalThis.structuredClone(current.schema);
  return current;
}

test("discovery declares its own finite result shape and preserves the historical baseline", () => {
  const previous = globalThis.structuredClone(floor);
  const current = discoverableFixture();
  assert.deepEqual(checkLocalApiContract(current, floor, discovery), { methods: 4, samples: 4 });
  assert.deepEqual(floor, previous);
  const incomplete = globalThis.structuredClone(current);
  incomplete.schema.methods[0].resultSchema = { type: "object" };
  assert.throws(() => checkLocalApiContract(incomplete, floor, discovery), /api.describe/);
});

test("discovery rejects missing metadata and invalid method, transport and error fields", () => {
  const mutations = [
    (value) => delete value.protocol,
    (value) => delete value.methods[1].inputSchema,
    (value) => {
      value.methods[1].name = "invalid\n";
    },
    (value) => {
      value.methods[1].resultSchema = "object";
    },
    (value) => {
      value.methods[1].effect = "execute";
    },
    (value) => {
      value.transport.maximumResponseBytes = "4194304";
    },
    (value) => {
      value.protocol.errors[0].exitCode = "2";
    },
    (value) => {
      value.protocol.cli.exitCodes["0"] = 0;
    },
    (value) => {
      value.protocol.compatibility.unknownOutputFields = "reject";
    },
  ];
  for (const mutate of mutations) {
    const current = discoverableFixture();
    mutate(current.samples[0].result);
    assert.throws(() => checkLocalApiContract(current, floor, discovery), /api.describe result/);
  }
});

test("discovery consumers accept additive metadata and future methods", () => {
  const current = discoverableFixture();
  const result = current.samples[0].result;
  result.future = true;
  result.transport.future = "metadata";
  result.methods[0].future = { optional: true };
  result.methods.push({ name: "future.read", effect: "read", inputSchema: true, resultSchema: {} });
  result.protocol.errors.push({ code: "future_failure", exitCode: 1, origin: "host", future: 1 });
  assert.doesNotThrow(() => checkLocalApiContract(current, floor, discovery));
});

test("protocol schemas enforce byte limits, strict inputs and additive outputs", () => {
  const ajv = contractValidator();
  const request = ajv.compile(protocol.requestSchema);
  const base = {
    version: 1,
    id: "consumer",
    token: "a".repeat(64),
    method: "hosts.list",
    params: {},
  };
  assert.equal(request(base), true);
  assert.equal(request({ ...base, id: "界".repeat(42) }), true);
  for (const change of [
    { id: "界".repeat(43) },
    { id: "x\n" },
    { method: "x\n" },
    { extra: true },
    { params: [] },
  ]) {
    assert.equal(request({ ...base, ...change }), false, JSON.stringify(change));
  }
  const response = ajv.compile(protocol.responseSchema);
  assert.equal(response({ version: 1, id: "r", result: null, future: true }), true);
  assert.equal(
    response({ version: 1, id: "r", error: { code: "future", message: "text", retryAfter: 1 } }),
    true,
  );
  for (const output of [
    { version: 1, id: "r" },
    { version: 1, id: "r", result: null, error: { code: "internal", message: "failed" } },
    { version: 1, id: "r", error: { code: 1, message: "failed" } },
    { version: 1, id: "r", error: null },
  ])
    assert.equal(response(output), false);
});

test("protocol checker requires actual errors, exit codes and wire coverage", () => {
  const actual = {
    schema: { protocol },
    wireSamples: Array.from({ length: 6 }, () => ({
      response: { version: 1, id: "r", result: {} },
    })),
    errorSamples: protocol.errors.map((entry) => ({
      exitCode: entry.exitCode,
      response: { version: 1, id: "r", error: { code: entry.code, message: "text" } },
    })),
  };
  assert.doesNotThrow(() => checkProtocolSamples(actual, protocol));
  const missing = globalThis.structuredClone(actual);
  missing.errorSamples.pop();
  assert.throws(() => checkProtocolSamples(missing, protocol), /Missing actual error producer/);
  const changed = globalThis.structuredClone(actual);
  changed.errorSamples[0].exitCode = 1;
  assert.throws(() => checkProtocolSamples(changed, protocol), /Error exit code changed/);
});

test("preference revision candidate matches the writer's UTF-8 and control bounds", async () => {
  const preferences = JSON.parse(
    await readFile(
      new URL("../../tests/fixtures/local-api/preferences-v1.json", import.meta.url),
      "utf8",
    ),
  );
  const schema = preferences.methods.find((method) => method.name === "preferences.update")
    .inputSchema.properties.revision;
  const validate = contractValidator().compile(schema);
  assert.equal(validate("界".repeat(42)), true);
  for (const value of ["界".repeat(43), "token\n", "\u0085", ""])
    assert.equal(validate(value), false);
});
