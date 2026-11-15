import assert from "node:assert/strict";
import { test } from "node:test";
import { credentialCommand, hasField, hasText, verifySeedHost } from "./ota.mjs";

test("credential metadata lookup accepts only a resolved UUID and explicit identity kind", () => {
  const id = "9694d335-6ed3-44c6-9a69-3618c092ccc5";
  assert.deepEqual(credentialCommand({ kind: "legacy", id }), ["credential", id]);
  assert.deepEqual(credentialCommand({ kind: "immutable", id }), ["credential-item", id]);
  for (const identity of [
    null,
    {},
    { kind: "other", id },
    { kind: "legacy", id: id + "\n" },
    { kind: "immutable", id: "tunnelde.credential.v1:" + id },
  ]) {
    assert.throws(() => credentialCommand(identity));
  }
});

test("synthetic host accepts the observed stable hosts.list DTO without internal auth fields", () => {
  verifySeedHost({
    address: "127.0.0.1",
    favorite: false,
    groupId: null,
    id: "9694d335-6ed3-44c6-9a69-3618c092ccc5",
    name: "OTA preserved host 主机",
    port: 2209,
    tags: [],
    username: "qa",
  });
});

test("synthetic host rejects incorrect public address, port and username", () => {
  const host = { address: "127.0.0.1", port: 2209, username: "qa" };
  for (const [key, value] of Object.entries({
    address: "127.0.0.2",
    port: 22,
    username: "other",
  })) {
    assert.throws(
      () => verifySeedHost({ ...host, [key]: value }),
      new RegExp(`Synthetic host ${key}`),
    );
  }
});

test("host auth summary is not an open password form (observed native AX roles)", () => {
  const summary = {
    traversalCompleted: true,
    nodes: [{ role: "AXStaticText", AXValue: "Password", AXTitle: "", AXDescription: "" }],
  };
  assert.equal(hasText(summary, "Password"), true);
  assert.equal(hasField(summary, "Password"), false);
  assert.equal(
    hasField(
      {
        traversalCompleted: true,
        nodes: [{ role: "AXTextField", AXTitle: "Password", AXDescription: "Password" }],
      },
      "Password",
    ),
    true,
  );
});

test("partial AX traversal cannot establish control readiness or dialog completion", () => {
  const partial = { traversalCompleted: false, nodes: [] };
  assert.throws(() => hasText(partial, "Updates"), /AX traversal/);
  assert.throws(() => hasField(partial, "Password"), /AX traversal/);
});
