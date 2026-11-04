import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BUILD_VERSION,
  betaSequence,
  betaVersion,
  compareReleaseTags,
  releaseChannel,
  releaseTitle,
} from "../metadata/channels.mjs";

test("stable, Beta and source-derived Nightly tags have independent channel identity", () => {
  for (const [tag, channel] of [
    ["v0.27.1", "stable"],
    ["v0.27.1-beta.3", "beta"],
    ["v0.27.1-beta.3.1", "beta"],
    ["v0.27.1-beta01", "beta"],
    ["v0.27.1-beta99", "beta"],
    ["v0.27.1-beta12.d.2.g0123456789ab", "nightly"],
    ["v0.27.1-alpha.1.d.3.g0123456789ab", "nightly"],
    ["v0.27.1-beta.3.d.2.g0123456789ab", "nightly"],
  ]) {
    assert.equal(releaseChannel(tag), channel);
    assert.equal(releaseTitle(tag), channel === "nightly" ? `${tag} (Nightly)` : tag);
  }
  for (const version of [
    "0.27.1-alpha.1",
    "0.27.1-beta.01",
    "0.27.1-beta00",
    "0.27.1-beta1",
    "0.27.1-beta001",
    "0.27.1-beta100",
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
    "v0.27.1-beta.11",
    "v0.27.1-beta.99",
    "v0.27.1-beta.100",
    "v0.27.1-beta01",
    "v0.27.1-beta09",
    "v0.27.1-beta10",
    "v0.27.1-beta11",
    "v0.27.1-beta99",
    "v0.27.1",
    "v0.27.2-alpha.1.d.1.gabcdef012345",
  ];
  assert.deepEqual([...ordered].reverse().sort(compareReleaseTags), ordered);
});

test("two-digit alphanumeric Beta identifiers are valid, lexical and SemVer order agree", () => {
  const ordered = Array.from(
    { length: 99 },
    (_, index) => `v${betaVersion("0.28.0", BigInt(index + 1))}`,
  );
  assert.deepEqual([...ordered].reverse().sort(), ordered);
  assert.deepEqual([...ordered].reverse().sort(compareReleaseTags), ordered);
  for (const tag of ordered) assert.equal(BUILD_VERSION.test(tag.slice(1)), true);
  assert.equal(betaSequence("v0.28.0-beta.11"), 11n);
  assert.equal(betaSequence("v0.28.0-beta.11.2"), 11n);
  assert.equal(betaSequence("v0.28.0-beta12"), 12n);
  assert.throws(() => betaVersion("0.28.0", 100n), /exhausted/);
  assert.throws(() => betaVersion("0.28.0", 0n), /exhausted/);
});
