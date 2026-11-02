import { spawnSync, execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { performance } from "node:perf_hooks";

const [target, variant] = process.argv.slice(2);
if (!/^(aarch64|x86_64)-apple-darwin$/.test(target ?? ""))
  throw new Error("Expected an Apple Silicon or Intel macOS target");
if (!["three-library-types", "rlib-only"].includes(variant))
  throw new Error("Invalid build measurement variant");

const started = performance.now();
const result = spawnSync(
  "pnpm",
  ["tauri", "build", "--no-bundle", "--target", target, "--", "--locked", "--timings"],
  { stdio: "inherit" },
);
const metrics = {
  target,
  variant,
  elapsedSeconds: Math.round((performance.now() - started) / 100) / 10,
  exitCode: result.status ?? 1,
  sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  toolchain: execFileSync("rustc", ["--version"], { encoding: "utf8" }).trim(),
  cacheExactMatch: process.env.CACHE_EXACT_MATCH === "true",
};
if (result.error) console.error(result.error.message);
if (result.status === 0) {
  const binary = readFileSync(`src-tauri/target/${target}/release/tunnelde`);
  metrics.binaryBytes = binary.length;
  metrics.gzipBytes = gzipSync(binary, { level: 9 }).length;
  const expectedArchitecture = target.startsWith("aarch64") ? "arm64" : "x86_64";
  const architecture = execFileSync(
    "lipo",
    ["-archs", `src-tauri/target/${target}/release/tunnelde`],
    { encoding: "utf8" },
  ).trim();
  if (architecture !== expectedArchitecture) throw new Error("Unexpected executable architecture");
}
mkdirSync("artifacts/build-performance", { recursive: true });
writeFileSync("artifacts/build-performance/metrics.json", `${JSON.stringify(metrics, null, 2)}\n`);
console.log(JSON.stringify(metrics));
process.exitCode = metrics.exitCode;
