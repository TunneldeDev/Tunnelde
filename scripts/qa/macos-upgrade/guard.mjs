import assert from "node:assert/strict";
import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, parse } from "node:path";
import { repository, assertUpgrade } from "../windows-upgrade/assets.mjs";

export const workflow = "macos-ota-probe.yml";

// These checks prevent accidental execution. Environment variables are not an
// attestation against an operator deliberately impersonating a hosted runner.
export function hostedContext({ env, platform, architecture, user, home, cwd }) {
  assert.equal(platform, "darwin", "Requires a disposable macOS runner");
  assert(["arm64", "x64"].includes(architecture));
  assert.equal(env.GITHUB_ACTIONS, "true");
  assert.equal(env.RUNNER_ENVIRONMENT, "github-hosted", "Self-hosted runners are forbidden");
  assert.equal(env.RUNNER_OS, "macOS");
  assert.equal(env.RUNNER_ARCH, architecture === "arm64" ? "ARM64" : "X64");
  assert.equal(user.username, "runner");
  assert(Number.isInteger(user.uid) && user.uid > 0, "Root execution is forbidden");
  assert.equal(user.homedir, "/Users/runner");
  assert.equal(home, "/Users/runner");
  assert.equal(env.HOME, home);
  assert.equal(env.GITHUB_REPOSITORY, repository);
  assert.equal(env.GITHUB_EVENT_NAME, "workflow_dispatch", "Manual dispatch only");
  assert.equal(env.MACOS_OTA_ACK, "probe-only", "Explicit probe-only acknowledgement required");
  assert.match(env.GITHUB_REF ?? "", /^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._/-]*$/);
  assert.equal(
    env.GITHUB_WORKFLOW_REF,
    `${repository}/.github/workflows/${workflow}@${env.GITHUB_REF}`,
  );
  assert.match(env.GITHUB_SHA ?? "", /^[a-f0-9]{40}$/);
  assert.match(env.GITHUB_RUN_ID ?? "", /^[1-9]\d{0,19}$/);
  assert.match(env.GITHUB_RUN_ATTEMPT ?? "", /^[1-9]\d{0,5}$/);
  assert.equal(env.RUNNER_TEMP, "/Users/runner/work/_temp");
  assert.equal(env.GITHUB_WORKSPACE, "/Users/runner/work/Tunnelde/Tunnelde");
  assert.equal(cwd, env.GITHUB_WORKSPACE);
  assert.equal(env.UPGRADE_FROM, "v1.2.1");
  assert.equal(env.UPGRADE_TO, "v1.3.0");
  assertUpgrade(env.UPGRADE_FROM, env.UPGRADE_TO);
  return {
    workspace: cwd,
    home,
    temp: env.RUNNER_TEMP,
    root: join(
      env.RUNNER_TEMP,
      `tunnelde-macos-ota-probe-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}`,
    ),
  };
}

export async function checkedDirectory(path, uid) {
  assert(isAbsolute(path) && normalize(path) === path);
  for (let current = path; ; current = dirname(current)) {
    const info = await lstat(current);
    assert(info.isDirectory() && !info.isSymbolicLink(), `Unsafe directory: ${current}`);
    if (current === path) {
      assert.equal(info.uid, uid, `Directory belongs to another user: ${path}`);
      assert.equal(info.mode & 0o022, 0, `Directory is writable by other users: ${path}`);
    }
    if (current === parse(current).root) break;
  }
  assert.equal(await realpath(path), path);
}

export function requireCapabilities(native) {
  assert.equal(native.schemaVersion, 1);
  for (const key of [
    "consoleUserMatches",
    "onConsole",
    "loginDone",
    "accessibilityTrusted",
    "screenCaptureAllowed",
  ]) {
    assert.equal(native[key], true, `Hosted GUI capability unavailable: ${key}`);
  }
  assert(Number.isInteger(native.screenCount) && native.screenCount > 0, "No desktop display");
}
