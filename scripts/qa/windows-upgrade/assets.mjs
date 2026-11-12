import assert from "node:assert/strict";

export const repository = "TunneldeDev/Tunnelde";

export function releaseVersion(tag) {
  assert.match(tag, /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-beta\.([1-9]))?$/);
  assert(tag.length < 64);
  const [version, beta] = tag.slice(1).split("-beta.");
  return [...version.split(".").map(BigInt), BigInt(beta ?? 10)];
}

export function assertUpgrade(from, to) {
  const a = releaseVersion(from),
    b = releaseVersion(to);
  const difference = a.findIndex((value, index) => value !== b[index]);
  assert(difference >= 0 && b[difference] > a[difference], "Target must be a newer release");
}

export function releaseAsset(release, tag) {
  releaseVersion(tag);
  assert.equal(release.tag_name, tag, "Release tag mismatch");
  assert.equal(release.draft, false, "Only public installers may be tested");
  const name = `Tunnelde_${tag.slice(1)}_x64-setup.exe`;
  const matches = release.assets.filter((asset) => asset.name === name);
  assert.equal(matches.length, 1, "Expected exactly one Windows installer");
  const asset = matches[0];
  assert.match(asset.digest, /^sha256:[a-f0-9]{64}$/);
  assert(Number.isSafeInteger(asset.size) && asset.size > 0);
  return { name, size: asset.size, sha256: asset.digest.slice(7) };
}
