#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)
//
// Builds an installer for local testing without touching the updater signing
// key. Release builds always run in CI, where the key is available.

import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "tunnelde-build-"));
const config = join(dir, "tauri.local.conf.json");
writeFileSync(
  config,
  `${JSON.stringify({ bundle: { createUpdaterArtifacts: false } }, null, 2)}\n`,
);

const command = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const child = spawn(command, ["tauri", "build", "--config", config], {
  stdio: "inherit",
  shell: process.platform === "win32",
});

child.on("exit", (code) => {
  process.exit(code ?? 1);
});
