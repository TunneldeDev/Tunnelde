#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)
//
// Builds latest.json from the updater signatures uploaded by the build jobs.
// Doing it once, after every platform finished, avoids the asset race that
// tauri-action hits when each job tries to replace the same manifest.

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const rules = [
  {
    pattern: /x64-setup\.exe\.sig$/,
    asset: (tag) => `Tunnelde_${tag.replace(/^v/, "")}_x64-setup.exe`,
    keys: ["windows-x86_64", "windows-x86_64-nsis"],
  },
  {
    pattern: /aarch64\.app\.tar\.gz\.sig$/,
    asset: () => "Tunnelde_aarch64.app.tar.gz",
    keys: ["darwin-aarch64", "darwin-aarch64-app"],
  },
  {
    pattern: /(?<!aarch64\.)x64\.app\.tar\.gz\.sig$/,
    asset: () => "Tunnelde_x64.app.tar.gz",
    keys: ["darwin-x86_64", "darwin-x86_64-app"],
  },
  {
    pattern: /amd64\.AppImage\.sig$/,
    asset: (tag) => `Tunnelde_${tag.replace(/^v/, "")}_amd64.AppImage`,
    keys: ["linux-x86_64", "linux-x86_64-appimage"],
  },
  {
    pattern: /amd64\.deb\.sig$/,
    asset: (tag) => `Tunnelde_${tag.replace(/^v/, "")}_amd64.deb`,
    keys: ["linux-x86_64-deb"],
  },
];

const REQUIRED = [
  "windows-x86_64",
  "darwin-aarch64",
  "darwin-x86_64",
  "linux-x86_64",
  "linux-x86_64-appimage",
  "linux-x86_64-deb",
];

function flag(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

try {
  const tag = flag("--tag");
  const directory = flag("--sig-dir");
  const output = flag("--out") ?? "latest.json";
  const repository = flag("--repo");
  if (!tag || !directory || !repository) {
    throw new Error("usage: updater-json.mjs --tag vX.Y.Z --sig-dir DIR --repo OWNER/NAME [--out FILE]");
  }

  const version = tag.replace(/^v/, "");
  const base = `https://github.com/${repository}/releases/download/${tag}`;
  const platforms = {};

  for (const name of readdirSync(directory)) {
    if (!name.endsWith(".sig")) {
      continue;
    }
    const rule = rules.find((candidate) => candidate.pattern.test(name));
    if (!rule) {
      continue;
    }
    const signature = readFileSync(join(directory, name), "utf8").trim();
    const asset = rule.asset(tag);
    for (const key of rule.keys) {
      platforms[key] = { signature, url: `${base}/${asset}` };
    }
    console.error(`[release] ${name} -> ${rule.keys.join(", ")}`);
  }

  const missing = REQUIRED.filter((key) => !platforms[key]);
  if (missing.length > 0) {
    throw new Error(`missing signatures for: ${missing.join(", ")}`);
  }

  const manifest = {
    version,
    pub_date: new Date().toISOString(),
    platforms,
  };
  writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`);
  console.error(`[release] wrote ${output} with ${Object.keys(platforms).length} platforms`);
} catch (error) {
  console.error(`[release] ${error.message}`);
  process.exit(1);
}
