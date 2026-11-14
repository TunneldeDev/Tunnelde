import assert from "node:assert/strict";
import { releaseVersion } from "../windows-upgrade/assets.mjs";

export function requireHostedLinux(env, platform, architecture) {
  assert.equal(platform, "linux", "This probe is Linux-only");
  assert.equal(architecture, "x64", "Only the public amd64 AppImage is supported");
  assert.equal(env.GITHUB_ACTIONS, "true", "Refusing a workstation run");
  assert.equal(env.RUNNER_ENVIRONMENT, "github-hosted", "Refusing a self-hosted runner");
  assert.equal(env.RUNNER_OS, "Linux");
  assert(env.RUNNER_TEMP && env.RUNNER_TEMP.startsWith("/"));
  assert(env.DISPLAY && env.DBUS_SESSION_BUS_ADDRESS, "A disposable graphical session is required");
}

export function appimageAsset(release, tag) {
  releaseVersion(tag);
  assert.equal(release.tag_name, tag);
  assert.equal(release.draft, false, "Only published original packages may be probed");
  const name = `Tunnelde_${tag.slice(1)}_amd64.AppImage`;
  const matches = release.assets.filter((asset) => asset.name === name);
  assert.equal(matches.length, 1, "Expected exactly one public AppImage");
  const asset = matches[0];
  assert.match(asset.digest, /^sha256:[a-f0-9]{64}$/);
  assert(Number.isSafeInteger(asset.size) && asset.size > 0);
  return { name, size: asset.size, sha256: asset.digest.slice(7) };
}
