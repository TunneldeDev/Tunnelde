import assert from "node:assert/strict";
import { test } from "node:test";
import { checkParserParity } from "./check-sdk-parser.mjs";

test("parser parity detects missing methods and changed method metadata", () => {
  const host = {
    version: 1,
    methods: [
      { name: "api.describe", permissions: [], stability: "stable", since: "0.21.0" },
      { name: "example", permissions: ["app.read"], stability: "experimental", since: null },
    ],
  };
  const clone = () => JSON.parse(JSON.stringify(host));
  checkParserParity(host, clone());
  const missing = clone();
  missing.methods.pop();
  assert.throws(() => checkParserParity(host, missing), /differs from the serialized host/);
  const changed = clone();
  changed.methods[0].stability = "experimental";
  assert.throws(() => checkParserParity(host, changed), /differs from the serialized host/);
});
