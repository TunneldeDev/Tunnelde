import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

const asset = process.env.HELPER_ASSET;
if (!/^(windows|macos|linux)-(x86_64|aarch64)$/.test(asset ?? ""))
  throw new Error("Invalid HELPER_ASSET");
const extension = asset.startsWith("windows-") ? ".exe" : "";
const targetTriple = process.env.HELPER_TARGET || "";
const macTargets = {
  "macos-aarch64": "aarch64-apple-darwin",
  "macos-x86_64": "x86_64-apple-darwin",
};
if (targetTriple && macTargets[asset] !== targetTriple)
  throw new Error("HELPER_TARGET does not match HELPER_ASSET");
const name = `tunnelde-agent-${asset}${extension}`;
const directory = "artifacts/helpers";
mkdirSync(directory, { recursive: true });
const target = join(directory, name);
copyFileSync(
  join("native-helpers/target", targetTriple, "release", `tunnelde-agent${extension}`),
  target,
);
const digest = createHash("sha256").update(readFileSync(target)).digest("hex");
writeFileSync(`${target}.sha256`, `${digest}  ${name}\n`);
