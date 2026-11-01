#!/usr/bin/env node
import { readFileSync } from "node:fs";

export function verifyAssets(tag, manifest, assets, { helpers = false } = {}) {
  const version = tag.replace(/^v/, "");
  if (manifest.version !== version) throw new Error("manifest version does not match tag");
  const names = new Set(assets.filter((asset) => asset.size > 0).map((asset) => asset.name));
  const required = new Set([
    "latest.json",
    `Tunnelde_${version}_aarch64.dmg`,
    `Tunnelde_${version}_x64.dmg`,
  ]);
  if (helpers) {
    for (const platform of [
      "windows-x86_64",
      "macos-aarch64",
      "macos-x86_64",
      "linux-x86_64",
      "linux-aarch64",
    ]) {
      const name = `tunnelde-agent-${platform}${platform.startsWith("windows-") ? ".exe" : ""}`;
      required.add(name);
      required.add(`${name}.sha256`);
    }
  }
  for (const platform of Object.values(manifest.platforms)) {
    if (!platform.signature?.trim()) throw new Error("manifest contains an empty signature");
    const url = new URL(platform.url);
    if (!url.pathname.includes(`/releases/download/${tag}/`)) {
      throw new Error("manifest URL does not match tag");
    }
    const name = decodeURIComponent(url.pathname.split("/").at(-1));
    required.add(name);
    required.add(`${name}.sig`);
  }
  for (const name of required) {
    if (!names.has(name)) throw new Error(`missing or empty release asset: ${name}`);
  }
}

if (process.argv[1]?.endsWith("verify-assets.mjs")) {
  const flag = (name) => process.argv[process.argv.indexOf(name) + 1];
  try {
    const tag = flag("--tag");
    const manifest = JSON.parse(readFileSync(flag("--manifest"), "utf8"));
    const { assets } = JSON.parse(readFileSync(flag("--assets"), "utf8"));
    verifyAssets(tag, manifest, assets, { helpers: process.argv.includes("--helpers") });
    console.log(`[release] verified all assets for ${tag}`);
  } catch (error) {
    console.error(`[release] ${error.message}`);
    process.exit(1);
  }
}
