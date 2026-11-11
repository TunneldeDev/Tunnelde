import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { releasePlatforms } from "../publishing/platforms.mjs";

test("normal releases retain all four desktop architectures and explicit macOS targets", () => {
  const matrix = releasePlatforms();
  assert.deepEqual(
    matrix.map((item) => item.name),
    ["windows-x86_64", "macos-aarch64", "macos-x86_64", "linux-x86_64"],
  );
  assert.equal(new Set(matrix.map((item) => item.name)).size, 4);
  assert.deepEqual(
    matrix.filter((item) => item.platform === "macos-15-intel").map((item) => item.target),
    ["aarch64-apple-darwin", "x86_64-apple-darwin"],
  );
});

test("recovery includes exactly one requested platform and cannot mutate future plans", () => {
  for (const item of releasePlatforms()) {
    const selected = releasePlatforms(item.name);
    assert.deepEqual(selected, [item]);
    selected[0].name = "modified";
    assert.deepEqual(releasePlatforms(item.name), [item]);
  }
  for (const invalid of ["", "linux", "all\nlinux-x86_64", "../linux", null, 1]) {
    assert.throws(() => releasePlatforms(invalid), /Unknown release platform/);
  }
});

test("partial recovery keeps immutable source and complete publication checks", () => {
  const workflow = readFileSync(
    new URL("../../../.github/workflows/release.yml", import.meta.url),
    "utf8",
  );
  assert(workflow.includes("include: ${{ fromJSON(needs.prepare.outputs.matrix) }}"));
  assert(workflow.includes("ref: ${{ inputs.existing_tag }}"));
  assert(workflow.includes("ref: ${{ needs.prepare.outputs.tag }}"));
  assert(workflow.includes("needs: [prepare, build]"));
  assert(workflow.includes("Verify complete desktop assets"));
  assert(workflow.includes(".release-tools/scripts/ci/linux/install-dependencies.mjs"));
  assert(!workflow.includes("sudo apt-get"));
});
