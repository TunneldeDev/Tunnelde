import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { hostedContext, checkedDirectory, requireCapabilities } from "./guard.mjs";

function hosted() {
  return {
    env: {
      GITHUB_ACTIONS: "true",
      RUNNER_ENVIRONMENT: "github-hosted",
      RUNNER_OS: "macOS",
      RUNNER_ARCH: "ARM64",
      HOME: "/Users/runner",
      GITHUB_REPOSITORY: "TunneldeDev/Tunnelde",
      GITHUB_EVENT_NAME: "workflow_dispatch",
      GITHUB_REF: "refs/heads/qa/macos-hosted-ota-probe",
      GITHUB_WORKFLOW_REF:
        "TunneldeDev/Tunnelde/.github/workflows/macos-ota-probe.yml@refs/heads/qa/macos-hosted-ota-probe",
      GITHUB_SHA: "a".repeat(40),
      GITHUB_RUN_ID: "123456",
      GITHUB_RUN_ATTEMPT: "1",
      GITHUB_WORKSPACE: "/Users/runner/work/Tunnelde/Tunnelde",
      RUNNER_TEMP: "/Users/runner/work/_temp",
      MACOS_OTA_ACK: "probe-only",
      UPGRADE_FROM: "v1.2.1",
      UPGRADE_TO: "v1.3.0",
    },
    platform: "darwin",
    architecture: "arm64",
    user: { username: "runner", uid: 501, homedir: "/Users/runner" },
    home: "/Users/runner",
    cwd: "/Users/runner/work/Tunnelde/Tunnelde",
  };
}

test("accepts the manual hosted context for each supported native architecture", () => {
  const context = hosted();
  assert.equal(
    hostedContext(context).root,
    "/Users/runner/work/_temp/tunnelde-macos-ota-probe-123456-1",
  );
  context.architecture = "x64";
  context.env.RUNNER_ARCH = "X64";
  assert.equal(hostedContext(context).temp, "/Users/runner/work/_temp");
});

for (const [key, value] of [
  ["GITHUB_ACTIONS", "false"],
  ["RUNNER_ENVIRONMENT", "self-hosted"],
  ["RUNNER_OS", "Linux"],
  ["RUNNER_ARCH", "X64"],
  ["HOME", "/Users/alice"],
  ["GITHUB_REPOSITORY", "someone/Tunnelde"],
  ["GITHUB_EVENT_NAME", "pull_request_target"],
  ["GITHUB_EVENT_NAME", "pull_request"],
  ["GITHUB_REF", "refs/tags/v1.3.0"],
  ["GITHUB_WORKFLOW_REF", "TunneldeDev/Tunnelde/.github/workflows/other.yml@refs/heads/dev"],
  ["GITHUB_SHA", "main"],
  ["GITHUB_RUN_ID", "../../elsewhere"],
  ["GITHUB_RUN_ATTEMPT", "0"],
  ["MACOS_OTA_ACK", "true"],
  ["RUNNER_TEMP", "/tmp"],
  ["RUNNER_TEMP", "/Users/runner/work/_temp/../_temp"],
  ["GITHUB_WORKSPACE", "/Users/runner/work/other/other"],
  ["UPGRADE_FROM", "v1.3.0"],
  ["UPGRADE_TO", "v1.4.0"],
]) {
  test(`rejects an unsafe ${key} value (${value})`, () => {
    const context = hosted();
    context.env[key] = value;
    assert.throws(() => hostedContext(context));
  });
}

test("rejects genuine host identity mismatches even with hosted environment strings", () => {
  for (const mutation of [
    (c) => {
      c.platform = "linux";
    },
    (c) => {
      c.architecture = "ppc64";
    },
    (c) => {
      c.user.uid = 0;
    },
    (c) => {
      c.user.username = "alice";
    },
    (c) => {
      c.user.homedir = "/Users/alice";
    },
    (c) => {
      c.home = "/Users/alice";
    },
    (c) => {
      c.cwd = "/Users/runner/work/Tunnelde/Tunnelde/subdir";
    },
  ]) {
    const context = hosted();
    mutation(context);
    assert.throws(() => hostedContext(context));
  }
});

test("filesystem checks reject symlink ancestors, shared writes, and foreign ownership", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "tunnelde-probe-guard-")));
  const uid = userInfo().uid;
  try {
    const target = join(root, "target");
    await mkdir(target, { mode: 0o700 });
    await checkedDirectory(target, uid);
    await mkdir(join(target, "nested"), { mode: 0o700 });
    await symlink(target, join(root, "alias"));
    await assert.rejects(checkedDirectory(join(root, "alias/nested"), uid), /Unsafe directory/);
    await assert.rejects(checkedDirectory(target, uid + 1), /another user/);
    await chmod(target, 0o777);
    await assert.rejects(checkedDirectory(target, uid), /writable by other users/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("missing GUI or TCC capability fails instead of becoming a green skip", () => {
  const native = {
    schemaVersion: 1,
    consoleUserMatches: true,
    onConsole: true,
    loginDone: true,
    screenCount: 1,
    accessibilityTrusted: true,
    screenCaptureAllowed: true,
  };
  requireCapabilities(native);
  for (const key of [
    "consoleUserMatches",
    "onConsole",
    "loginDone",
    "accessibilityTrusted",
    "screenCaptureAllowed",
  ]) {
    for (const invalid of [false, undefined, "true"]) {
      assert.throws(
        () => requireCapabilities({ ...native, [key]: invalid }),
        /capability unavailable/,
      );
    }
  }
  assert.throws(() => requireCapabilities({ ...native, screenCount: 0 }), /No desktop display/);
});

test("the real entry point refuses a non-manual context before touching its root", async () => {
  const run = promisify(execFile);
  await assert.rejects(
    run(process.execPath, [new URL("./run.mjs", import.meta.url).pathname], {
      env: { ...process.env, GITHUB_EVENT_NAME: "pull_request", RUNNER_ENVIRONMENT: "self-hosted" },
      timeout: 10000,
    }),
    (error) => error.code === 1 && /AssertionError/.test(error.stderr),
  );
});
