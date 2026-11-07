import { rmSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";

// A timed-out extraction may have left valid fingerprints beside incomplete files.
// This helper is only for disposable hosted runners, before any compilation starts.
if (process.env.GITHUB_ACTIONS !== "true" || process.env.RUNNER_ENVIRONMENT !== "github-hosted")
  throw new Error("Rust cache recovery requires a disposable GitHub-hosted runner");
const workspace = process.argv[2];
if (workspace !== "src-tauri") throw new Error("Expected a known Rust workspace");
const root = process.env.GITHUB_WORKSPACE;
if (!root || !isAbsolute(root)) throw new Error("Expected an absolute GitHub workspace");
const cargoHome = resolve(process.env.CARGO_HOME || join(homedir(), ".cargo"));
const paths = [
  [resolve(root), `${workspace}/target`],
  [cargoHome, "registry"],
  [cargoHome, "git"],
];
const targets = paths.map(([parent, child]) => {
  const target = resolve(parent, child);
  if (!target.startsWith(`${parent}${sep}`)) throw new Error("Invalid Rust cache recovery path");
  return target;
});
for (const target of targets) {
  console.log(`Discard incomplete Rust cache: ${target}`);
  rmSync(target, { recursive: true, force: true, maxRetries: 3 });
}
