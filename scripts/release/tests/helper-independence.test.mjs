import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { test } from "node:test";
import { VERSION_PATHS } from "../metadata/version-files.mjs";

const read = (path) => readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");

test("desktop versioning and workflows are independent of optional helper source", () => {
  assert.equal(VERSION_PATHS.length, 6);
  assert(VERSION_PATHS.every((path) => !path.startsWith("native-helpers/")));
  for (const path of [
    ".github/workflows/ci.yml",
    ".github/workflows/release.yml",
    ".github/workflows/release-version.yml",
    "scripts/release/version.mjs",
  ])
    assert.doesNotMatch(read(path), /native-helpers|build_helpers/);
  assert.equal(existsSync(new URL("../../../native-helpers/Cargo.toml", import.meta.url)), false);
});

test("branch protection requires the remaining application checks without removed helper jobs", () => {
  for (const path of [".github/dev-ruleset.json", ".github/main-ruleset.json"]) {
    const rules = JSON.parse(read(path)).rules;
    const checks = rules
      .find((rule) => rule.type === "required_status_checks")
      .parameters.required_status_checks.map((check) => check.context);
    assert(!checks.some((name) => name.startsWith("Native helpers")));
    for (const name of [
      "Web",
      "Rust",
      "Repository hygiene",
      "Windows application check",
      "macOS application check",
      "PR policy",
    ])
      assert(checks.includes(name), `${path}: missing ${name}`);
  }
});

test("pull-request CI runs only for a non-draft reviewable head", () => {
  const ci = read(".github/workflows/ci.yml");
  assert.match(
    ci,
    /pull_request:\n\s+branches: \[main, dev\]\n\s+types: \[[^\]]*ready_for_review[^\]]*\]/,
  );
  assert.equal(
    [
      ...ci.matchAll(
        /^\s{4}if: github\.event_name != 'pull_request' \|\| !github\.event\.pull_request\.draft$/gm,
      ),
    ].length,
    5,
  );
});
