import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BUILD_VERSION,
  compareReleaseTags,
  releaseChannel,
  releaseTitle,
} from "../metadata/channels.mjs";

test("stable, Beta and source-derived Nightly tags have independent channel identity", () => {
  for (const [tag, channel] of [
    ["v0.27.1", "stable"],
    ["v0.27.1-beta.3", "beta"],
    ["v0.27.1-beta.3.1", "beta"],
    ["v0.27.1-alpha.1.d.3.g0123456789ab", "nightly"],
    ["v0.27.1-beta.3.d.2.g0123456789ab", "nightly"],
  ]) {
    assert.equal(releaseChannel(tag), channel);
    assert.equal(releaseTitle(tag), channel === "nightly" ? `${tag} (Nightly)` : tag);
  }
  for (const version of [
    "0.27.1-alpha.1",
    "0.27.1-beta.01",
    "0.27.1-beta.1.d.01.gabcdef1",
    "01.27.1",
    "main",
    "0.27.1-rc.1",
  ])
    assert.equal(BUILD_VERSION.test(version), false, version);
});

test("Nightly distance, Beta milestones and new target versions follow SemVer order", () => {
  const ordered = [
    "v0.27.0",
    "v0.27.1-alpha.1.d.999.gabcdef012345",
    "v0.27.1-alpha.1.d.1000.gabcdef012345",
    "v0.27.1-beta.1",
    "v0.27.1-beta.1.d.10.gabcdef012345",
    "v0.27.1-beta.2",
    "v0.27.1-beta.9",
    "v0.27.1-beta.10",
    "v0.27.1",
    "v0.27.2-alpha.1.d.1.gabcdef012345",
  ];
  assert.deepEqual([...ordered].reverse().sort(compareReleaseTags), ordered);
});
