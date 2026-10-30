#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const changelog = join(root, "CHANGELOG.md");
const UNRELEASED = "## [Unreleased]";

export function changelogNotes(version) {
  const text = readFileSync(changelog, "utf8");
  const marker = `## [${version}]`;
  const start = text.indexOf(marker);
  if (start < 0) {
    throw new Error(`CHANGELOG.md has no section for ${version}`);
  }
  const bodyStart = text.indexOf("\n", start) + 1;
  const next = text.indexOf("\n## [", bodyStart);
  return text.slice(bodyStart, next < 0 ? text.length : next).trim();
}

/**
 * Moves everything under `## [Unreleased]` into a dated section for `version`.
 * Fails when the section is empty so releases always carry curated notes.
 */
export function releaseChangelog(version, date = new Date().toISOString().slice(0, 10)) {
  const text = readFileSync(changelog, "utf8");
  const start = text.indexOf(UNRELEASED);
  if (start < 0) {
    throw new Error("CHANGELOG.md is missing the ## [Unreleased] section");
  }

  const bodyStart = start + UNRELEASED.length;
  const next = text.indexOf("\n## [", bodyStart);
  const body = text.slice(bodyStart, next < 0 ? text.length : next).trim();
  if (!body) {
    throw new Error("## [Unreleased] is empty; write the release notes first");
  }

  const heading = `## [${version}] - ${date}`;
  const tail = next < 0 ? "" : text.slice(next).trimEnd();
  const nextText = `${text.slice(0, start)}${UNRELEASED}\n\n${heading}\n\n${body}\n${tail ? `\n${tail}\n` : ""}`;
  writeFileSync(changelog, nextText);
  return heading;
}

if (process.argv[1]?.endsWith("changelog.mjs")) {
  try {
    const command = process.argv[2];
    const version = process.argv[3];
    if (command === "notes") {
      console.log(changelogNotes(version));
    } else if (command === "release") {
      console.log(releaseChangelog(version, process.argv[4]));
    } else {
      throw new Error("usage: changelog.mjs notes|release <version> [date]");
    }
  } catch (error) {
    console.error(`[release] ${error.message}`);
    process.exit(1);
  }
}
