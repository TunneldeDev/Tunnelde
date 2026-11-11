import assert from "node:assert/strict";
import { test } from "node:test";
import { checkLoggingContract } from "./check-logging-contract.mjs";
const page = () => ({
  version: 1,
  source: "diagnostics",
  entries: [
    {
      timestamp: null,
      level: "warn",
      domain: "network",
      pluginId: null,
      message: "text",
      fields: { status: 403 },
      truncated: false,
    },
  ],
  cursor: "opaque",
  hasMore: false,
  gap: false,
  reset: false,
});
test("log machine contract rejects internal fields and invalid shape/bounds", () => {
  checkLoggingContract(page());
  for (const change of [
    (v) => (v.path = "private"),
    (v) => (v.version = 2),
    (v) => (v.cursor = "a\n"),
    (v) => (v.entries[0].domain = "bad/id"),
    (v) => (v.entries[0].level = "WARN"),
    (v) => (v.entries[0].message = "x".repeat(16385)),
    (v) => (v.entries[0].pluginId = 1),
    (v) => (v.hasMore = "yes"),
  ]) {
    const value = page();
    change(value);
    assert.throws(() => checkLoggingContract(value));
  }
});
