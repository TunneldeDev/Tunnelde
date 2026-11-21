import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { upstreamSecretScanExclusions } from "./check-russh-vendor.mjs";

function fixture(run) {
  const root = mkdtempSync(join(tmpdir(), "tunnelde-upstream-"));
  const header = ["BEGIN", "PRIVATE", "KEY"].join(" ");
  const original = `Public upstream test fixture: ${header}`;
  const baseline = {
    modified: ["patched.rs"],
    files: {
      "original.rs": createHash("sha256").update(original).digest("hex"),
      "patched.rs": "upstream-patched-file-digest",
    },
  };
  writeFileSync(join(root, "original.rs"), original);
  writeFileSync(join(root, "patched.rs"), `local source: ${header}`);
  try {
    run(root, baseline);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("only byte-identical upstream content receives a secret-scan exemption", () => {
  fixture((root, baseline) =>
    assert.deepEqual(upstreamSecretScanExclusions(root, baseline), ["original.rs"]),
  );
});
test("changed public fixture content fails closed", () => {
  fixture((root, baseline) => {
    writeFileSync(join(root, "original.rs"), "altered fixture");
    assert.throws(() => upstreamSecretScanExclusions(root, baseline), /Modified upstream file/);
  });
});
test("new or missing files and unsafe paths cannot bypass the scan", () => {
  fixture((root, baseline) => {
    writeFileSync(join(root, "extra.rs"), "unexpected");
    assert.throws(() => upstreamSecretScanExclusions(root, baseline), /Unknown vendored file/);
    rmSync(join(root, "extra.rs"));
    baseline.files["../escape"] = "bad";
    assert.throws(() => upstreamSecretScanExclusions(root, baseline), /Invalid upstream path/);
    delete baseline.files["../escape"];
    rmSync(join(root, "original.rs"));
    assert.throws(() => upstreamSecretScanExclusions(root, baseline));
  });
});
test("symlinks are never treated as upstream files", () => {
  fixture((root, baseline) => {
    rmSync(join(root, "original.rs"));
    symlinkSync(join(root, "patched.rs"), join(root, "original.rs"));
    assert.throws(() => upstreamSecretScanExclusions(root, baseline), /vendored symlink/);
  });
});
