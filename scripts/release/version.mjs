#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BUILD_VERSION } from "./metadata/channels.mjs";
import { VERSION_PATHS, versionContents } from "./metadata/version-files.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const files = {
  package: join(root, "package.json"),
  config: join(root, "src-tauri", "tauri.conf.json"),
  cargo: join(root, "src-tauri", "Cargo.toml"),
  lock: join(root, "src-tauri", "Cargo.lock"),
  manifest: join(root, ".release-please-manifest.json"),
  citation: join(root, "CITATION.cff"),
};

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

export { VERSION_PATHS, versionContents } from "./metadata/version-files.mjs";

export function currentVersion() {
  return JSON.parse(readFileSync(files.package, "utf8")).version;
}

export function bumpVersion(version, part) {
  const match = SEMVER.exec(version);
  if (!match) {
    throw new Error(`invalid version: ${version}`);
  }
  const [major, minor, patch] = match.slice(1).map(Number);
  switch (part) {
    case "major":
      return `${major + 1}.0.0`;
    case "minor":
      return `${major}.${minor + 1}.0`;
    case "patch":
      return `${major}.${minor}.${patch + 1}`;
    default:
      throw new Error(`invalid part: ${part}`);
  }
}

export function compareVersions(left, right) {
  const parse = (value) => {
    const match = SEMVER.exec(value);
    if (!match) {
      throw new Error(`invalid version: ${value}`);
    }
    return match.slice(1).map(Number);
  };
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) {
      return a[index] < b[index] ? -1 : 1;
    }
  }
  return 0;
}

export function setVersion(version) {
  const contents = Object.fromEntries(
    VERSION_PATHS.map((path) => [path, readFileSync(join(root, path), "utf8")]),
  );
  const updated = versionContents(contents, version);
  for (const [path, content] of Object.entries(updated)) writeFileSync(join(root, path), content);
  return version;
}

export function checkVersion(tag) {
  const candidate = String(tag ?? "");
  // Branch names such as "main" are not release tags and must be ignored.
  const expected = BUILD_VERSION.test(candidate.replace(/^v/, ""))
    ? candidate.replace(/^v/, "")
    : "";
  const pkg = currentVersion();
  const cargoMatch = /^version = "([^"]+)"$/m.exec(readFileSync(files.cargo, "utf8"));
  const config = JSON.parse(readFileSync(files.config, "utf8")).version;
  const lockMatch = /\[\[package\]\]\r?\nname = "tunnelde"\r?\nversion = "([^"]+)"/.exec(
    readFileSync(files.lock, "utf8"),
  );
  const problems = [];
  const citationVersion = /^version: ["']?([^\s"']+)["']?$/m.exec(
    readFileSync(files.citation, "utf8"),
  )?.[1];
  if (citationVersion !== pkg)
    problems.push(`CITATION.cff ${citationVersion} != package.json ${pkg}`);
  const manifestVersion = JSON.parse(readFileSync(files.manifest, "utf8"))["."];
  if (manifestVersion !== pkg) {
    problems.push(`release manifest ${manifestVersion} != package.json ${pkg}`);
  }
  if (!cargoMatch) {
    problems.push("src-tauri/Cargo.toml has no package version");
  } else if (cargoMatch[1] !== pkg) {
    problems.push(`Cargo.toml ${cargoMatch[1]} != package.json ${pkg}`);
  }
  if (config !== pkg) {
    problems.push(`tauri.conf.json ${config} != package.json ${pkg}`);
  }
  if (!lockMatch) {
    problems.push("src-tauri/Cargo.lock has no tunnelde package version");
  } else if (lockMatch[1] !== pkg) {
    problems.push(`Cargo.lock ${lockMatch[1]} != package.json ${pkg}`);
  }
  if (expected && expected !== pkg) {
    problems.push(`tag ${expected} != package.json ${pkg}`);
  }
  if (problems.length > 0) {
    throw new Error(problems.join("\n"));
  }
  return pkg;
}

function flag(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

if (process.argv[1]?.endsWith("version.mjs")) {
  try {
    const command = process.argv[2];
    if (command === "current") {
      console.log(currentVersion());
    } else if (command === "bump") {
      console.log(bumpVersion(currentVersion(), flag("--part") ?? "patch"));
    } else if (command === "set") {
      console.log(setVersion(process.argv[3]));
    } else if (command === "check") {
      console.log(`versions match ${checkVersion(process.argv[3] ?? process.env.GITHUB_REF_NAME)}`);
    } else {
      throw new Error("usage: version.mjs current|bump|set|check");
    }
  } catch (error) {
    console.error(`[release] ${error.message}`);
    process.exit(1);
  }
}
