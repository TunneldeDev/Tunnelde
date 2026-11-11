import assert from "node:assert/strict";
import { test } from "node:test";
import { checkStorageContract } from "./check-storage-contract.mjs";
const changed = () => ({
  version: 1,
  revision: "r",
  changed: true,
  snapshot: { version: 1, revision: "r", values: { x: null } },
});
const fixture = () => ({
  initial: changed(),
  idle: { version: 1, revision: "r", changed: false },
  unicode: changed(),
  decimal: changed(),
});
test("storage schema checks strict public shapes, keys and paired revisions", () => {
  checkStorageContract(fixture());
  for (const mutate of [
    (value) => {
      value.initial.snapshot.locations = { path: "private" };
    },
    (value) => {
      value.initial.snapshot.values = Object.fromEntries([["__proto__", null]]);
    },
    (value) => {
      value.initial.snapshot.values = { "key\n": null };
    },
    (value) => {
      value.initial.snapshot.revision = "other";
    },
    (value) => {
      value.idle.snapshot = null;
    },
    (value) => {
      value.idle.revision = "other";
    },
    (value) => {
      value.unicode.revision = "r\n";
    },
    (value) => {
      value.decimal.snapshot.values.x = "x".repeat(514 * 1024);
    },
  ]) {
    const value = fixture();
    mutate(value);
    assert.throws(() => checkStorageContract(value));
  }
});
