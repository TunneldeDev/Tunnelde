import assert from "node:assert/strict";
import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, parse } from "node:path";
import { repository, assertUpgrade } from "../windows-upgrade/assets.mjs";

export const runnerHome = join("/Users", "runner");
const runnerWork = join(runnerHome, "work");

export const workflow = "macos-ota-probe.yml";

// These checks prevent accidental execution. Environment variables are not an
// attestation against an operator deliberately impersonating a hosted runner.
export function hostedContext({
  env,
  platform,
  architecture,
  user,
  home,
  cwd,
  workflowFile = workflow,
  acknowledgement = "probe-only",
}) {
  assert([workflow, "macos-public-ota.yml"].includes(workflowFile));
  assert.equal(acknowledgement, workflowFile === workflow ? "probe-only" : "original-public-ota");
  assert.equal(platform, "darwin", "Requires a disposable macOS runner");
  assert(["arm64", "x64"].includes(architecture));
  assert.equal(env.GITHUB_ACTIONS, "true");
  assert.equal(env.RUNNER_ENVIRONMENT, "github-hosted", "Self-hosted runners are forbidden");
  assert.equal(env.RUNNER_OS, "macOS");
  assert.equal(env.RUNNER_ARCH, architecture === "arm64" ? "ARM64" : "X64");
  assert.equal(user.username, "runner");
  assert(Number.isInteger(user.uid) && user.uid > 0, "Root execution is forbidden");
  assert.equal(user.homedir, runnerHome);
  assert.equal(home, runnerHome);
  assert.equal(env.HOME, home);
  assert.equal(env.GITHUB_REPOSITORY, repository);
  assert.equal(env.GITHUB_EVENT_NAME, "workflow_dispatch", "Manual dispatch only");
  assert.equal(env.MACOS_OTA_ACK, acknowledgement, "Explicit manual acknowledgement required");
  assert.match(env.GITHUB_REF ?? "", /^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._/-]*$/);
  assert.equal(
    env.GITHUB_WORKFLOW_REF,
    `${repository}/.github/workflows/${workflowFile}@${env.GITHUB_REF}`,
  );
  assert.match(env.GITHUB_SHA ?? "", /^[a-f0-9]{40}$/);
  assert.match(env.GITHUB_RUN_ID ?? "", /^[1-9]\d{0,19}$/);
  assert.match(env.GITHUB_RUN_ATTEMPT ?? "", /^[1-9]\d{0,5}$/);
  assert.equal(env.RUNNER_TEMP, join(runnerWork, "_temp"));
  assert.equal(env.GITHUB_WORKSPACE, join(runnerWork, "Tunnelde", "Tunnelde"));
  assert.equal(cwd, env.GITHUB_WORKSPACE);
  if (workflowFile === workflow) {
    assert.equal(env.UPGRADE_FROM, "v1.2.1");
    assert.equal(env.UPGRADE_TO, "v1.3.0");
  }
  assertUpgrade(env.UPGRADE_FROM, env.UPGRADE_TO);
  if (workflowFile === "macos-public-ota.yml") {
    for (const tag of [env.UPGRADE_FROM, env.UPGRADE_TO]) {
      assert(!tag.includes("-"), "Original public OTA requires stable release tags");
    }
  }
  return {
    workspace: cwd,
    home,
    temp: env.RUNNER_TEMP,
    root: join(
      env.RUNNER_TEMP,
      `${workflowFile === workflow ? "tunnelde-macos-ota-probe" : "tunnelde-macos-public-ota"}-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}`,
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
