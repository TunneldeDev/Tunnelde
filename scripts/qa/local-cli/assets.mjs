import assert from "node:assert/strict";
import { releaseVersion } from "../windows-upgrade/assets.mjs";

export function packagedAsset(release, tag, platform, architecture) {
  releaseVersion(tag);
  assert.equal(release.tag_name, tag);
  assert.equal(release.draft, false, "Only public releases may be tested");
  const suffix = {
    "linux:x64": "amd64.deb",
    "darwin:x64": "x64.app.tar.gz",
    "darwin:arm64": "aarch64.app.tar.gz",
  }[`${platform}:${architecture}`];
  assert(suffix, "Unsupported packaged CLI platform");
  const name = `Tunnelde_${tag.slice(1)}_${suffix}`;
  const matches = release.assets.filter((asset) => asset.name === name);
  assert.equal(matches.length, 1, "Expected exactly one matching public package");
  const asset = matches[0];
  assert.match(asset.digest, /^sha256:[a-f0-9]{64}$/);
  assert(Number.isSafeInteger(asset.size) && asset.size > 0);
  return { name, size: asset.size, sha256: asset.digest.slice(7) };
}
