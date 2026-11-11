import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const platforms = [
  { platform: "windows-latest", name: "windows-x86_64", args: "" },
  // Build both macOS architectures on Intel to avoid arm64 runner shortages.
  {
    platform: "macos-15-intel",
    name: "macos-aarch64",
    target: "aarch64-apple-darwin",
    arch: "arm64",
    args: "--target aarch64-apple-darwin",
  },
  {
    platform: "macos-15-intel",
    name: "macos-x86_64",
    target: "x86_64-apple-darwin",
    arch: "x86_64",
    args: "--target x86_64-apple-darwin",
  },
  { platform: "ubuntu-22.04", name: "linux-x86_64", args: "" },
];

/** Partial recovery reuses the immutable tag and full final asset verification. */
export function releasePlatforms(selection = "all") {
  const selected = platforms.filter((item) => selection === "all" || item.name === selection);
  if (!selected.length) throw new Error(`Unknown release platform: ${selection}`);
  return selected.map((item) => ({ ...item }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const matrix = releasePlatforms(process.env.RELEASE_PLATFORM ?? "all");
  if (!process.env.GITHUB_OUTPUT) throw new Error("GITHUB_OUTPUT is required");
  appendFileSync(process.env.GITHUB_OUTPUT, `matrix=${JSON.stringify(matrix)}\n`);
}
