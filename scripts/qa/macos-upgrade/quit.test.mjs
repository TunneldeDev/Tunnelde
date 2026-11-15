import assert from "node:assert/strict";
import { test } from "node:test";
import { verifyTargetQuit } from "./quit.mjs";

const target = {
  pid: 123,
  startSeconds: 10,
  startMicroseconds: 20,
  executable: "/owned/tunnelde",
  identifier: "dev.tunnelde.app",
};

function fixture({ keyboardExits = false, replacement = false, menuExits = true } = {}) {
  const report = {};
  const actions = [];
  let alive = true;
  let captured = false;
  const primary = new Error("Timed out waiting for normal target Quit");
  const actual = replacement ? { ...target, startMicroseconds: 21 } : target;
  const native = async (action, ...args) => {
    actions.push([action, ...args]);
    if (action === "key") {
      if (keyboardExits) alive = false;
      return { identity: target, generatedOSInput: true };
    }
    if (action === "locate") return { processes: alive ? [actual] : [] };
    if (action === "focus")
      return { identity: actual, focus: { frontmostPid: target.pid, targetActive: true } };
    if (action === "activate") return { identity: actual, activated: true };
    if (action === "press") {
      alive = !menuExits;
      return { identity: actual, matches: 1, traversalCompleted: true, axStatus: 0 };
    }
    assert.fail(`Unexpected native action ${action}`);
  };
  return {
    options: {
      target,
      report,
      native,
      capture: async () => {
        captured = true;
      },
      wait: async (label, condition) => {
        if (!(await condition())) throw label === "normal target Quit" ? primary : new Error(label);
      },
    },
    report,
    actions,
    primary,
    captured: () => captured,
  };
}

test("normal keyboard exit does not activate or press the diagnostic menu", async () => {
  const f = fixture({ keyboardExits: true });
  await verifyTargetQuit(f.options);
  assert(!f.report.targetQuitDiagnostic);
  assert(f.actions.every(([action]) => ["key", "locate"].includes(action)));
  assert.equal(f.captured(), false);
});

test("successful native menu diagnosis preserves the original failed keyboard acceptance", async () => {
  const f = fixture();
  await assert.rejects(verifyTargetQuit(f.options), (error) => error === f.primary);
  assert.equal(f.report.targetQuitDiagnostic.menuObservedExit, true);
  assert.equal(f.captured(), true);
  assert.deepEqual(
    f.actions.find(([action]) => action === "press"),
    ["press", target.pid, "Quit Tunnelde"],
  );
  assert.equal(f.report.normalTargetQuit, undefined);
  assert.equal(f.report.otaCoreAccepted, undefined);
});

test("PID reuse prevents diagnostic activation and menu actions", async () => {
  const f = fixture({ replacement: true });
  await assert.rejects(verifyTargetQuit(f.options), (error) => error === f.primary);
  assert.match(f.report.targetQuitDiagnostic.failure, /startMicroseconds changed/);
  assert(!f.actions.some(([action]) => ["activate", "press"].includes(action)));
  assert.equal(f.captured(), false);
});

test("a menu timeout does not replace the primary keyboard failure", async () => {
  const f = fixture({ menuExits: false });
  await assert.rejects(verifyTargetQuit(f.options), (error) => error === f.primary);
  assert.match(f.report.targetQuitDiagnostic.failure, /diagnostic native menu Quit/);
  assert.equal(f.report.targetQuitDiagnostic.menuObservedExit, undefined);
});
