import assert from "node:assert/strict";
import { win32 } from "node:path";

// NSIS RunAsUser restarts from Explorer, which does not inherit the harness's
// TUNNELDE_DATA_DIR. Exercise the normal profile on a disposable hosted runner.
export function nativeProfileDirectory(env) {
  assert.equal(env.GITHUB_ACTIONS, "true");
  assert.equal(env.RUNNER_ENVIRONMENT, "github-hosted");
  assert.equal(typeof env.APPDATA, "string");
  assert(win32.isAbsolute(env.APPDATA), "A native Windows roaming profile is required");
  return win32.join(env.APPDATA, "dev.tunnelde.app");
}
