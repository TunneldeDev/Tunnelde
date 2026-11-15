import assert from "node:assert/strict";

const identityFields = ["pid", "startSeconds", "startMicroseconds", "executable", "identifier"];

function sameProcess(actual, expected) {
  assert(actual && expected, "Missing owned process identity");
  for (const key of identityFields) {
    assert.notEqual(expected[key], undefined, `Missing owned process ${key}`);
    assert.equal(actual[key], expected[key], `Quit diagnostic process ${key} changed`);
  }
}

// The alternate menu action diagnoses a failed keyboard path. It never converts
// the original failed acceptance to success, including when the menu exits.
export async function verifyTargetQuit({ native, target, report, wait, capture }) {
  report.targetQuitInput = await native("key", target.pid, "quit");
  try {
    await wait("normal target Quit", async () => !(await native("locate")).processes.length);
  } catch (error) {
    const diagnostic = { primaryFailure: String(error?.stack ?? error) };
    report.targetQuitDiagnostic = diagnostic;
    try {
      const owned = (await native("locate")).processes;
      assert.equal(owned.length, 1, "Quit diagnosis requires exactly one owned target");
      sameProcess(owned[0], target);
      const before = await native("focus", target.pid);
      sameProcess(before.identity, target);
      diagnostic.before = before;
      await capture();
      const activation = await native("activate", target.pid);
      sameProcess(activation.identity, target);
      assert.equal(activation.activated, true);
      await wait(
        "owned target frontmost for menu diagnostic",
        async () => {
          const current = await native("focus", target.pid);
          sameProcess(current.identity, target);
          diagnostic.beforeMenu = current;
          return current.focus.frontmostPid === target.pid && current.focus.targetActive === true;
        },
        10000,
      );
      // Exact enabled AX menu label in the original English native app menu.
      // No IPC exit, AppleScript terminate, signal, or alternate Quit entry.
      diagnostic.menuAction = await native("press", target.pid, "Quit Tunnelde");
      sameProcess(diagnostic.menuAction.identity, target);
      assert.equal(diagnostic.menuAction.matches, 1);
      assert.equal(diagnostic.menuAction.traversalCompleted, true);
      assert.equal(diagnostic.menuAction.axStatus, 0);
      await wait(
        "diagnostic native menu Quit",
        async () => !(await native("locate")).processes.length,
      );
      diagnostic.menuObservedExit = true;
    } catch (diagnosticError) {
      diagnostic.failure = String(diagnosticError?.stack ?? diagnosticError);
    }
    throw error;
  }
}
