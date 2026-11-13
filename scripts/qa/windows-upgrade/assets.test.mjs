import assert from "node:assert/strict";
import { test } from "node:test";
import { assertUpgrade, releaseAsset } from "./assets.mjs";

const release = () => ({
  tag_name: "v0.37.0",
  draft: false,
  assets: [
    { name: "Tunnelde_0.37.0_x64-setup.exe", digest: `sha256:${"a".repeat(64)}`, size: 123 },
  ],
});

test("upgrade order is numeric and beta precedes the same stable release", () => {
  assertUpgrade("v0.9.0", "v0.11.0");
  assertUpgrade("v0.37.0-beta.9", "v0.37.0");
  assertUpgrade("v0.37.0", "v0.38.0-beta.1");
  for (const [from, to] of [
    ["v0.37.0", "v0.37.0"],
    ["v0.37.0", "v0.36.0"],
    ["v0.37.0", "v0.37.0-beta.9"],
    ["v0.37.0", "v00.38.0"],
  ])
    assert.throws(() => assertUpgrade(from, to));
});

test("selects the exact public installer and requires its published digest", () => {
  assert.deepEqual(releaseAsset(release(), "v0.37.0"), {
    name: "Tunnelde_0.37.0_x64-setup.exe",
    size: 123,
    sha256: "a".repeat(64),
  });
  for (const mutate of [
    (r) => {
      r.draft = true;
    },
    (r) => {
      r.tag_name = "v0.36.0";
    },
    (r) => {
      r.assets[0].digest = null;
    },
    (r) => {
      r.assets[0].size = 0;
    },
    (r) => {
      r.assets.push({ ...r.assets[0] });
    },
    (r) => {
      r.assets[0].name = "Tunnelde_setup.exe";
    },
  ]) {
    const invalid = release();
    mutate(invalid);
    assert.throws(() => releaseAsset(invalid, "v0.37.0"));
  }
  for (const tag of ["../unsafe", "v0.37.0-beta.10", "v0.37.0;echo unsafe"])
    assert.throws(() => releaseAsset(release(), tag));
});
