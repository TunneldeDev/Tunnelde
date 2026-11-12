import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { checkLocalApiContract } from "./check-local-api-contract.mjs";

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
