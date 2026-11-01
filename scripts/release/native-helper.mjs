import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

const asset = process.env.HELPER_ASSET;
if (!/^(windows|macos|linux)-(x86_64|aarch64)$/.test(asset ?? ""))
  throw new Error("Invalid HELPER_ASSET");
const extension = asset.startsWith("windows-") ? ".exe" : "";
const name = `tunnelde-agent-${asset}${extension}`;
const directory = "artifacts/helpers";
mkdirSync(directory, { recursive: true });
const target = join(directory, name);
copyFileSync(`native-helpers/target/release/tunnelde-agent${extension}`, target);
const digest = createHash("sha256").update(readFileSync(target)).digest("hex");
writeFileSync(`${target}.sha256`, `${digest}  ${name}\n`);
