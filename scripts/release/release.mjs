#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

import { releaseChangelog } from "./changelog.mjs";
import { bumpVersion, compareVersions, currentVersion, setVersion } from "./version.mjs";

function flag(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

try {
  const current = currentVersion();
  const explicit = flag("--version");
  const part = flag("--part") ?? "patch";
  const next = explicit ?? bumpVersion(current, part);

  if (compareVersions(next, current) <= 0) {
    throw new Error(`${next} must be greater than ${current}`);
  }

  setVersion(next);
  const heading = releaseChangelog(next);
  console.log(next);
  console.error(`[release] ${heading}`);
} catch (error) {
  console.error(`[release] ${error.message}`);
  process.exit(1);
}
