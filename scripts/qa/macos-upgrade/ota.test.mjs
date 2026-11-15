import assert from "node:assert/strict";
import { test } from "node:test";
import { hasField, hasText } from "./ota.mjs";

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
