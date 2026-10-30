#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const files = {
  package: join(root, "package.json"),
  config: join(root, "src-tauri", "tauri.conf.json"),
  cargo: join(root, "src-tauri", "Cargo.toml"),
  lock: join(root, "src-tauri", "Cargo.lock"),
};

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

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
  if (!SEMVER.test(version)) {
    throw new Error(`invalid version: ${version}`);
  }

  const pkg = JSON.parse(readFileSync(files.package, "utf8"));
  pkg.version = version;
  writeFileSync(files.package, `${JSON.stringify(pkg, null, 2)}\n`);

  const config = JSON.parse(readFileSync(files.config, "utf8"));
  config.version = version;
  writeFileSync(files.config, `${JSON.stringify(config, null, 2)}\n`);

  const cargo = readFileSync(files.cargo, "utf8");
  const nextCargo = cargo.replace(
    /(\[package\][\s\S]*?\nversion = ")[^"]+(")/,
    `$1${version}$2`,
  );
  if (nextCargo === cargo) {
    throw new Error("could not update src-tauri/Cargo.toml");
  }
  writeFileSync(files.cargo, nextCargo);

  const lock = readFileSync(files.lock, "utf8");
  const nextLock = lock.replace(
    /(\[\[package\]\]\nname = "tunnelde"\nversion = ")[^"]+(")/,
    `$1${version}$2`,
  );
  if (nextLock === lock) {
    throw new Error("could not update src-tauri/Cargo.lock");
  }
  writeFileSync(files.lock, nextLock);

  return version;
}

export function checkVersion(tag) {
  const candidate = String(tag ?? "");
  // Branch names such as "main" are not release tags and must be ignored.
  const expected = /^v?\d+\.\d+\.\d+$/.test(candidate) ? candidate.replace(/^v/, "") : "";
  const pkg = currentVersion();
  const cargoMatch = /^version = "([^"]+)"$/m.exec(readFileSync(files.cargo, "utf8"));
  const config = JSON.parse(readFileSync(files.config, "utf8")).version;
  const problems = [];

  if (!cargoMatch) {
    problems.push("src-tauri/Cargo.toml has no package version");
  } else if (cargoMatch[1] !== pkg) {
    problems.push(`Cargo.toml ${cargoMatch[1]} != package.json ${pkg}`);
  }
  if (config !== pkg) {
    problems.push(`tauri.conf.json ${config} != package.json ${pkg}`);
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
