import assert from "node:assert/strict";
import { test } from "node:test";
import { appimageAsset, requireHostedLinux } from "./policy.mjs";

test("reject workstation, self-hosted, wrong platform and missing graphical session before launch", () => {
  const env = {
    GITHUB_ACTIONS: "true",
    RUNNER_ENVIRONMENT: "github-hosted",
    RUNNER_OS: "Linux",
    RUNNER_TEMP: "/tmp/runner",
    DISPLAY: ":99",
    DBUS_SESSION_BUS_ADDRESS: "unix:path=/tmp/disposable-bus",
  };
  requireHostedLinux(env, "linux", "x64");
  for (const patch of [
    { GITHUB_ACTIONS: "false" },
    { RUNNER_ENVIRONMENT: "self-hosted" },
    { RUNNER_OS: "macOS" },
    { RUNNER_TEMP: "relative" },
    { DISPLAY: "" },
    { DBUS_SESSION_BUS_ADDRESS: "" },
  ])
    assert.throws(() => requireHostedLinux({ ...env, ...patch }, "linux", "x64"));
  assert.throws(() => requireHostedLinux(env, "darwin", "x64"));
  assert.throws(() => requireHostedLinux(env, "linux", "arm64"));
});

test("select exact immutable published AppImage with its GitHub digest", () => {
  const tag = "v1.2.1";
  const asset = {
    name: "Tunnelde_1.2.1_amd64.AppImage",
    size: 123,
    digest: `sha256:${"a".repeat(64)}`,
  };
  const release = { tag_name: tag, draft: false, assets: [asset] };
  assert.deepEqual(appimageAsset(release, tag), {
    name: asset.name,
    size: 123,
    sha256: "a".repeat(64),
  });
  for (const invalid of [
    { ...release, draft: true },
    { ...release, tag_name: "v1.3.0" },
    { ...release, assets: [] },
    { ...release, assets: [asset, asset] },
    { ...release, assets: [{ ...asset, size: 0 }] },
    { ...release, assets: [{ ...asset, digest: null }] },
    { ...release, assets: [{ ...asset, name: "../Tunnelde_1.2.1_amd64.AppImage" }] },
  ])
    assert.throws(() => appimageAsset(invalid, tag));
  assert.throws(() => appimageAsset(release, "../unsafe"));
  assert.throws(() => appimageAsset(release, "v1.3.0-beta.10"));
});
