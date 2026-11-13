import assert from "node:assert/strict";
import { test } from "node:test";
import { packagedAsset } from "./assets.mjs";

test("public package selection matches the actual runner architecture", () => {
  const tag = "v0.38.0-beta.1";
  const assets = ["amd64.deb", "x64.app.tar.gz", "aarch64.app.tar.gz"].map((suffix) => ({
    name: `Tunnelde_0.38.0-beta.1_${suffix}`,
    size: 42,
    digest: `sha256:${"a".repeat(64)}`,
  }));
  const release = { tag_name: tag, draft: false, assets };
  for (const [platform, architecture, index] of [
    ["linux", "x64", 0],
    ["darwin", "x64", 1],
    ["darwin", "arm64", 2],
  ]) {
    assert.equal(packagedAsset(release, tag, platform, architecture).name, assets[index].name);
  }
  for (const invalid of [
    { ...release, draft: true },
    { ...release, tag_name: "v0.37.0" },
    { ...release, assets: [] },
    { ...release, assets: [...assets, assets[0]] },
    { ...release, assets: [{ ...assets[0], digest: null }] },
    { ...release, assets: [{ ...assets[0], size: -1 }] },
  ])
    assert.throws(() => packagedAsset(invalid, tag, "linux", "x64"));
  assert.throws(() => packagedAsset(release, tag, "linux", "arm64"));
  assert.throws(() => packagedAsset(release, "../unsafe", "linux", "x64"));
});
