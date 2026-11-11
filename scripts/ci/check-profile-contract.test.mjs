import assert from "node:assert/strict";
import { test } from "node:test";
import { checkProfileContract } from "./check-profile-contract.mjs";

const fixture = () => ({
  initial: {
    version: 1,
    revision: "r",
    changed: true,
    snapshot: { version: 1, revision: "r", items: [{ id: "work", name: "Work", updatedAt: 0 }] },
  },
  idle: { version: 1, revision: "r", changed: false },
});

test("profile schema validates actual response shapes, bounds and pairing", () => {
  checkProfileContract(fixture());
  for (const mutate of [
    (value) => {
      value.initial.snapshot.items[0].settings = { private: true };
    },
    (value) => {
      value.initial.snapshot.items[0].updatedAt = 0.5;
    },
    (value) => {
      value.initial.snapshot.items = Array(33).fill(value.initial.snapshot.items[0]);
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
  ]) {
    const value = fixture();
    mutate(value);
    assert.throws(() => checkProfileContract(value));
  }
});
