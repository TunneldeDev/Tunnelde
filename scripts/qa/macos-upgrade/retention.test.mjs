import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { seedData, verifyData } from "./retention-plugin.mjs";
import { secretHash } from "./retention.mjs";

function fixture() {
  const host = {
    id: "synthetic",
    name: "OTA preserved host 主机",
    host: "127.0.0.1",
    port: 2209,
    username: "qa",
  };
  const state = { storage: null, secret: null, history: [], calls: [] };
  const call = async (method, params) => {
    state.calls.push(method);
    switch (method) {
      case "hosts.snapshot":
        return { hosts: [host] };
      case "history.record":
        state.history.push({ command: params.command });
        return null;
      case "history.list":
        return state.history;
      case "storage.get":
        return state.storage;
      case "storage.set":
        state.storage = globalThis.structuredClone(params.value);
        return null;
      case "secrets.set":
        state.secret = params.value;
        return null;
      case "secrets.get":
        return state.secret;
      default:
        assert.fail(`Unexpected RPC ${method}`);
    }
  };
  return { state, call };
}

test("target verification cannot seed absent data or repair lost secrets/history", async () => {
  const { state, call } = fixture();
  await assert.rejects(verifyData(call), /missing/);
  assert.deepEqual(state.calls, ["storage.get"]);
  await seedData(call);
  state.calls = [];
  const expected = await verifyData(call);
  assert.equal(expected.secretSha256, createHash("sha256").update(state.secret).digest("hex"));
  assert(!state.calls.some((name) => /\.(set|record|delete)$/.test(name)));
  state.secret = "changed";
  await assert.rejects(verifyData(call), /Secret missing or changed/);
  state.history = [];
  await assert.rejects(verifyData(call), /History missing/);
  assert(!state.calls.some((name) => /\.(set|record|delete)$/.test(name)));
});

test("AX digest read fails on truncated or ambiguous output", () => {
  const node = {
    role: "AXStaticText",
    AXValue: JSON.stringify({
      hostRetained: true,
      nonemptyHistory: true,
      storageRetained: true,
      secretSha256: "a".repeat(64),
    }),
  };
  assert.equal(secretHash({ traversalCompleted: true, nodes: [node] }), "a".repeat(64));
  assert.throws(() => secretHash({ traversalCompleted: false, nodes: [node] }));
  assert.throws(() => secretHash({ traversalCompleted: true, nodes: [node, node] }));
});

test("source refuses to overwrite an earlier uncertain seed", async () => {
  const { state, call } = fixture();
  await seedData(call);
  state.calls = [];
  const secret = state.secret;
  await assert.rejects(seedData(call), /already exists/);
  assert.equal(state.secret, secret);
  assert.deepEqual(state.calls, ["storage.get"]);
});
