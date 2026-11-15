import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { hostedContext, checkedDirectory, requireCapabilities, runnerHome } from "./guard.mjs";

function hosted() {
  return {
    env: {
      GITHUB_ACTIONS: "true",
      RUNNER_ENVIRONMENT: "github-hosted",
      RUNNER_OS: "macOS",
      RUNNER_ARCH: "ARM64",
      HOME: runnerHome,
      GITHUB_REPOSITORY: "TunneldeDev/Tunnelde",
      GITHUB_EVENT_NAME: "workflow_dispatch",
      GITHUB_REF: "refs/heads/qa/macos-hosted-ota-probe",
      GITHUB_WORKFLOW_REF:
        "TunneldeDev/Tunnelde/.github/workflows/macos-ota-probe.yml@refs/heads/qa/macos-hosted-ota-probe",
      GITHUB_SHA: "a".repeat(40),
      GITHUB_RUN_ID: "123456",
      GITHUB_RUN_ATTEMPT: "1",
      GITHUB_WORKSPACE: join(runnerHome, "work", "Tunnelde", "Tunnelde"),
      RUNNER_TEMP: join(runnerHome, "work", "_temp"),
      MACOS_OTA_ACK: "probe-only",
      UPGRADE_FROM: "v1.2.1",
      UPGRADE_TO: "v1.3.0",
    },
    platform: "darwin",
    architecture: "arm64",
    user: { username: "runner", uid: 501, homedir: runnerHome },
    home: runnerHome,
    cwd: join(runnerHome, "work", "Tunnelde", "Tunnelde"),
  };
}

function publicHosted(from = "v1.3.1", to = "v1.4.0") {
  const context = hosted();
  context.workflowFile = "macos-public-ota.yml";
  context.acknowledgement = "original-public-ota";
  context.env.GITHUB_WORKFLOW_REF = context.env.GITHUB_WORKFLOW_REF.replace(
    "macos-ota-probe.yml",
    "macos-public-ota.yml",
  );
  context.env.MACOS_OTA_ACK = context.acknowledgement;
  context.env.UPGRADE_FROM = from;
  context.env.UPGRADE_TO = to;
  return context;
}

test("original-public OTA accepts explicit stable upgrades using numeric component ordering", () => {
  for (const [from, to] of [
    ["v1.2.1", "v1.3.0"],
    ["v1.3.1", "v1.4.0"],
    ["v1.9.9", "v1.10.0"],
    ["v1.99.0", "v2.0.0"],
    ["v1.9007199254740992.0", "v1.9007199254740993.0"],
  ]) {
    for (const architecture of ["arm64", "x64"]) {
      const context = publicHosted(from, to);
      context.architecture = architecture;
      context.env.RUNNER_ARCH = architecture === "arm64" ? "ARM64" : "X64";
      assert.equal(
        hostedContext(context).root,
        join(runnerHome, "work", "_temp", "tunnelde-macos-public-ota-123456-1"),
      );
    }
  }
});

test("original-public OTA rejects equal, older, missing, noncanonical and prerelease tags", () => {
  for (const [from, to] of [
    ["v1.3.1", "v1.3.1"],
    ["v1.4.0", "v1.3.1"],
    ["v1.10.0", "v1.9.9"],
    [undefined, "v1.4.0"],
    ["v1.3.1", undefined],
    ["v01.3.1", "v1.4.0"],
    ["v1.3.1", "1.4.0"],
    ["v1.3.1", "v1.4.0+build"],
    ["v1.3.1", "v1.4.0\n"],
    ["v1.3.1", "nightly"],
    ["v1.3.1", "v1.4.0-beta.3"],
    ["v1.4.0-beta.3", "v1.4.0"],
  ]) {
    const context = publicHosted();
    context.env.UPGRADE_FROM = from;
    context.env.UPGRADE_TO = to;
    assert.throws(() => hostedContext(context));
  }
});

test("a valid public stable pair cannot bypass the disposable manual runner checks", () => {
  for (const mutate of [
    (c) => {
      c.env.RUNNER_ENVIRONMENT = "self-hosted";
    },
    (c) => {
      c.env.GITHUB_EVENT_NAME = "pull_request";
    },
    (c) => {
      c.env.MACOS_OTA_ACK = "probe-only";
    },
    (c) => {
      c.env.GITHUB_WORKFLOW_REF = c.env.GITHUB_WORKFLOW_REF.replace(
        "macos-public-ota.yml",
        "macos-ota-probe.yml",
      );
    },
    (c) => {
      c.user.username = "qysyw";
    },
    (c) => {
      c.cwd = join(runnerHome, "work", "other");
    },
  ]) {
    const context = publicHosted();
    mutate(context);
    assert.throws(() => hostedContext(context));
  }
});

test("accepts the manual hosted context for each supported native architecture", () => {
  const context = hosted();
  assert.equal(
    hostedContext(context).root,
    join(runnerHome, "work", "_temp", "tunnelde-macos-ota-probe-123456-1"),
  );
  context.architecture = "x64";
  context.env.RUNNER_ARCH = "X64";
  assert.equal(hostedContext(context).temp, join(runnerHome, "work", "_temp"));
});

test("original-public execution needs its separate workflow and acknowledgement", () => {
  const context = hosted();
  context.workflowFile = "macos-public-ota.yml";
  context.acknowledgement = "original-public-ota";
  context.env.GITHUB_WORKFLOW_REF = context.env.GITHUB_WORKFLOW_REF.replace(
    "macos-ota-probe.yml",
    "macos-public-ota.yml",
  );
  assert.throws(() => hostedContext(context));
  context.env.MACOS_OTA_ACK = "original-public-ota";
  assert.equal(
    hostedContext(context).root,
    join(runnerHome, "work", "_temp", "tunnelde-macos-public-ota-123456-1"),
  );
  assert.throws(() => hostedContext({ ...context, workflowFile: "other.yml" }));
  assert.throws(() => hostedContext({ ...context, acknowledgement: "probe-only" }));
});

for (const [key, value] of [
  ["GITHUB_ACTIONS", "false"],
  ["RUNNER_ENVIRONMENT", "self-hosted"],
  ["RUNNER_OS", "Linux"],
  ["RUNNER_ARCH", "X64"],
  ["HOME", "/tmp/not-hosted"],
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
  ["RUNNER_TEMP", join(runnerHome, "work", "_temp") + "/../_temp"],
  ["GITHUB_WORKSPACE", join(runnerHome, "work", "other", "other")],
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
      c.user.homedir = "/tmp/not-hosted";
    },
    (c) => {
      c.home = "/tmp/not-hosted";
    },
    (c) => {
      c.cwd = join(runnerHome, "work", "Tunnelde", "Tunnelde", "subdir");
    },
  ]) {
    const context = hosted();
    mutation(context);
    assert.throws(() => hostedContext(context));
  }
});

test(
  "filesystem checks reject symlink ancestors, shared writes, and foreign ownership",
  {
    skip: process.platform === "win32" ? "POSIX uid, mode and symlink semantics only" : false,
  },
  async () => {
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
  },
);

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
    for (const invalid of [false, undefined, "true", 1]) {
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
    run(process.execPath, [fileURLToPath(new URL("./run.mjs", import.meta.url))], {
      env: { ...process.env, GITHUB_EVENT_NAME: "pull_request", RUNNER_ENVIRONMENT: "self-hosted" },
      timeout: 10000,
    }),
    (error) => error.code === 1 && /AssertionError/.test(error.stderr),
  );
});

test("the original-public entry refuses a local machine before profile access", async () => {
  await assert.rejects(
    promisify(execFile)(
      process.execPath,
      [fileURLToPath(new URL("./public.mjs", import.meta.url))],
      {
        env: {
          ...process.env,
          GITHUB_EVENT_NAME: "pull_request",
          RUNNER_ENVIRONMENT: "self-hosted",
        },
        timeout: 10000,
      },
    ),
    (error) => error.code === 1 && /AssertionError/.test(error.stderr),
  );
});
