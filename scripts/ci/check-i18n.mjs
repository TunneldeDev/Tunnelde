#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)
//
// Fails when the two catalogues drift apart: every key must exist in both
// en-US and zh-CN with a non-empty string.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const locales = ["en-US", "zh-CN"];

function flatten(value, prefix = "", out = new Map()) {
  for (const [key, entry] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      flatten(entry, path, out);
    } else {
      out.set(path, entry);
    }
  }
  return out;
}

const catalogues = {};
for (const locale of locales) {
  const file = join(root, "src", "i18n", `${locale}.json`);
  catalogues[locale] = flatten(JSON.parse(readFileSync(file, "utf8")));
}

const problems = [];
for (const locale of locales) {
  const other = locales.find((candidate) => candidate !== locale);
  for (const [key] of catalogues[locale]) {
    if (!catalogues[other].has(key)) {
      problems.push(`${locale}: ${key} is missing from ${other}`);
    }
  }
}

if (problems.length > 0) {
  for (const problem of problems) {
    console.error(`[i18n] ${problem}`);
  }
  process.exit(1);
}

console.log(`[i18n] ${catalogues["en-US"].size} keys match across ${locales.join(" and ")}`);
