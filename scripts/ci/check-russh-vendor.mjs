import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Only byte-identical public upstream files may be exempted from the private-key
// header heuristic. Patched transport files and every new file remain scanned.
export function upstreamSecretScanExclusions(root, baseline) {
  const modified = new Set(baseline.modified);
  const extras = new Set(["LICENSE.txt", "TUNNELDE-PATCH.md", "upstream-sha256.json"]);
  const exclusions = [];
  function visit(directory, prefix = "") {
    for (const name of readdirSync(directory)) {
      const relative = prefix + name;
      const path = resolve(directory, name);
      const stat = lstatSync(path);
      assert.ok(!stat.isSymbolicLink(), `Unexpected vendored symlink: ${relative}`);
      if (stat.isDirectory()) {
        visit(path, relative + "/");
        continue;
      }
      assert.ok(stat.isFile(), `Unexpected vendored file type: ${relative}`);
      assert.ok(
        Object.hasOwn(baseline.files, relative) || extras.has(relative),
        `Unknown vendored file: ${relative}`,
      );
    }
  }
  visit(root);
  for (const [name, expected] of Object.entries(baseline.files)) {
    assert.ok(
      !name.includes("\\") &&
        name.split("/").every((part) => part && part !== "." && part !== ".."),
      "Invalid upstream path",
    );
    const path = resolve(root, name);
    assert.ok(lstatSync(path).isFile(), `Missing upstream file: ${name}`);
    if (modified.has(name)) continue;
    const data = readFileSync(path);
    assert.equal(
      createHash("sha256").update(data).digest("hex"),
      expected,
      `Modified upstream file: ${name}`,
    );
    if (/BEGIN [A-Z ]*PRIVATE KEY/.test(data.toString("utf8"))) exclusions.push(name);
  }
  for (const name of modified)
    assert.ok(Object.hasOwn(baseline.files, name), `Unknown patch target: ${name}`);
  return exclusions;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const root = resolve("src-tauri/vendor/russh");
  const baseline = JSON.parse(readFileSync(resolve(root, "upstream-sha256.json"), "utf8"));
  assert.equal(baseline.crate, "russh");
  assert.equal(baseline.version, "0.65.1");
  assert.equal(
    baseline.archiveSha256,
    "94be3d86c71b9ed220a675c405e35c7a02565a009bf8da2e9cc13a700320a5c5",
  );
  for (const path of upstreamSecretScanExclusions(root, baseline)) {
    process.stdout.write(`:!src-tauri/vendor/russh/${path}\n`);
  }
}
