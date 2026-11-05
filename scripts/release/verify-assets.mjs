#!/usr/bin/env node
import { readFileSync } from "node:fs";

export function verifyAssets(tag, manifest, assets) {
  const version = tag.replace(/^v/, "");
  if (manifest.version !== version) throw new Error("manifest version does not match tag");
  for (const asset of assets) {
    if (/^tunnelde-agent(?:[-.]|$)/i.test(asset.name))
      throw new Error(
        `native helpers belong in Actions artifacts, not desktop releases: ${asset.name}`,
      );
    if (asset.name.startsWith("Tunnelde_") && !asset.name.startsWith(`Tunnelde_${version}_`))
      throw new Error(`release asset filename does not match version: ${asset.name}`);
  }
  const names = new Set(assets.filter((asset) => asset.size > 0).map((asset) => asset.name));
  const required = new Set([
    "latest.json",
    `Tunnelde_${version}_aarch64.dmg`,
    `Tunnelde_${version}_x64.dmg`,
  ]);
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
    if (process.argv.includes("--helpers"))
      throw new Error(
        "--helpers is no longer supported; native helpers belong in Actions artifacts",
      );
    const tag = flag("--tag");
    const manifest = JSON.parse(readFileSync(flag("--manifest"), "utf8"));
    const { assets } = JSON.parse(readFileSync(flag("--assets"), "utf8"));
    verifyAssets(tag, manifest, assets);
    console.log(`[release] verified all assets for ${tag}`);
  } catch (error) {
    console.error(`[release] ${error.message}`);
    process.exit(1);
  }
}
