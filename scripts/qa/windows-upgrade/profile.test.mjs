import assert from "node:assert/strict";
import { test } from "node:test";
import { nativeProfileDirectory } from "./profile.mjs";

test("OTA uses the native hosted-runner profile independently of child environment overrides", () => {
  const env = {
    GITHUB_ACTIONS: "true",
    RUNNER_ENVIRONMENT: "github-hosted",
    APPDATA: "D:\\qa-profile\\AppData\\Roaming",
    TUNNELDE_DATA_DIR: "D:\\temporary-child-only-data",
  };
  assert.equal(
    nativeProfileDirectory(env),
    "D:\\qa-profile\\AppData\\Roaming\\dev.tunnelde.app",
  );
  for (const patch of [
    { GITHUB_ACTIONS: undefined },
    { RUNNER_ENVIRONMENT: "self-hosted" },
    { APPDATA: undefined },
    { APPDATA: "relative" },
  ])
    assert.throws(() => nativeProfileDirectory({ ...env, ...patch }));
});
