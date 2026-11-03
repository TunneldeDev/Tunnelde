import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const script = fileURLToPath(new URL("../../ci/reset-rust-cache.mjs", import.meta.url));

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "tunnelde-cache-recovery-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  const cargoHome = join(root, "cargo");
  const files = [
    "workspace/src-tauri/target/release/partial.rlib",
    "workspace/native-helpers/target/debug/partial.rlib",
    "workspace/src-tauri/src/main.rs",
    "workspace/native-helpers/src/main.rs",
    "cargo/registry/src/partial.rs",
    "cargo/git/db/partial",
    "cargo/bin/cargo",
  ];
  for (const file of files) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), "preserve unless cache");
  }
  return {
    root,
    run: (workspaceName, env = {}) =>
      spawnSync(process.execPath, [script, workspaceName], {
        encoding: "utf8",
        env: {
          ...process.env,
          GITHUB_ACTIONS: "true",
          RUNNER_ENVIRONMENT: "github-hosted",
          GITHUB_WORKSPACE: workspace,
          CARGO_HOME: cargoHome,
          ...env,
        },
      }),
  };
}

test("failed Rust restores discard incomplete cache but retain sources, tools and other workspaces", (t) => {
  for (const workspace of ["src-tauri", "native-helpers"]) {
    const f = fixture(t);
    const result = f.run(workspace);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(join(f.root, "workspace", workspace, "target")), false);
    assert.equal(existsSync(join(f.root, "cargo/registry")), false);
    assert.equal(existsSync(join(f.root, "cargo/git")), false);
    for (const path of [
      "workspace/src-tauri/src/main.rs",
      "workspace/native-helpers/src/main.rs",
      "cargo/bin/cargo",
      `workspace/${workspace === "src-tauri" ? "native-helpers" : "src-tauri"}/target`,
    ])
      assert.equal(existsSync(join(f.root, path)), true, path);
    assert.equal(f.run(workspace).status, 0, "recovery is idempotent");
  }
});

test("cache recovery refuses local execution, self-hosted runners and unknown workspaces before deletion", (t) => {
  for (const [workspace, env] of [
    ["src-tauri", { GITHUB_ACTIONS: "false" }],
    ["src-tauri", { RUNNER_ENVIRONMENT: "self-hosted" }],
    ["src-tauri", { GITHUB_WORKSPACE: "" }],
    ["src-tauri", { GITHUB_WORKSPACE: "relative/path" }],
    ["../src-tauri", {}],
  ]) {
    const f = fixture(t);
    assert.notEqual(f.run(workspace, env).status, 0);
    assert.equal(existsSync(join(f.root, "workspace/src-tauri/target")), true);
    assert.equal(existsSync(join(f.root, "cargo/registry/src/partial.rs")), true);
  }
});
