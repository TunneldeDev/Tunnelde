import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, readdir, writeFile, cp } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { packagedAsset } from "./assets.mjs";
import { applicationEnvironment, offlineCli, verifyLocalCli } from "./verify.mjs";
import { repository } from "../windows-upgrade/assets.mjs";

assert.equal(process.env.GITHUB_ACTIONS, "true");
assert.equal(process.env.RUNNER_ENVIRONMENT, "github-hosted");
assert(["linux", "darwin"].includes(process.platform));
assert(process.env.RUNNER_TEMP);
const run = promisify(execFile);
const root = resolve(process.env.RUNNER_TEMP, "tunnelde-local-cli");
const evidence = join(root, "evidence");
const data = join(root, "data");
await mkdir(evidence, { recursive: true });
await mkdir(data, { recursive: true });
const tag = process.env.CLI_RELEASE;
const report = {
  tag,
  platform: process.platform,
  architecture: process.arch,
  checks: [],
  scope:
    "Public package execution and seven live CLI methods in isolated hosted-runner data. Not OTA, GUI interaction, installation registration, physical hardware or old-data migration acceptance.",
};
let child;
let exit;
let closed;
let output = "";
const env = applicationEnvironment({ TUNNELDE_DATA_DIR: data });
try {
  const { stdout } = await run("gh", ["api", `repos/${repository}/releases/tags/${tag}`], {
    timeout: 45000,
    maxBuffer: 4 * 1024 * 1024,
  });
  const asset = packagedAsset(JSON.parse(stdout), tag, process.platform, process.arch);
  report.asset = asset;
  await run(
    "gh",
    ["release", "download", tag, "--repo", repository, "--pattern", asset.name, "--dir", root],
    { timeout: 120000 },
  );
  const archive = join(root, asset.name);
  const bytes = await readFile(archive);
  assert.equal(bytes.length, asset.size);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), asset.sha256);
  const extracted = join(root, "package");
  await mkdir(extracted);
  let binary;
  if (process.platform === "darwin") {
    await run("tar", ["-xzf", archive, "-C", extracted], { timeout: 30000 });
    const bundles = (await readdir(extracted)).filter((name) => name.endsWith(".app"));
    assert.equal(bundles.length, 1);
    binary = join(extracted, bundles[0], "Contents/MacOS/tunnelde");
  } else {
    await run("dpkg-deb", ["-x", archive, extracted], { timeout: 30000 });
    binary = join(extracted, "usr/bin/tunnelde");
  }
  const version = tag.slice(1);
  await offlineCli(binary, version, env);
  report.checks.push(
    "Exact public package SHA256/size and offline CLI verified before GUI startup",
  );
  child = spawn(binary, [], { env, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (bytes) => {
    output = (output + bytes).slice(-256000);
  });
  child.stderr.on("data", (bytes) => {
    output = (output + bytes).slice(-256000);
  });
  closed = new Promise((resolve) => {
    child.once("error", (error) => {
      exit = { error: String(error) };
      resolve(exit);
    });
    child.once("exit", (code, signal) => {
      exit = { code, signal };
      resolve(exit);
    });
  });
  const pointer = join(data, "automation.json");
  let ready = false;
  for (let attempt = 0; attempt < 180; attempt++) {
    assert(!exit, `Packaged desktop exited before readiness: ${JSON.stringify(exit)}`);
    try {
      await readFile(pointer);
      ready = true;
      break;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await delay(500);
  }
  assert(ready, "Packaged desktop did not publish its isolated automation endpoint");
  report.cli = await verifyLocalCli(binary, version, pointer, { env });
  report.checks.push(
    "All seven real packaged CLI methods, stale-write rejection and preference restoration passed",
  );
} catch (error) {
  report.failure = String(error?.stack ?? error);
  console.error(report.failure);
  process.exitCode = 1;
} finally {
  if (child && !exit) {
    child.kill("SIGTERM");
    await Promise.race([closed, delay(8000)]);
    if (!exit) {
      child.kill("SIGKILL");
      await closed;
    }
  }
  // Process termination cleans this disposable run; it is not normal-quit evidence.
  report.cleanupExit = exit;
  await writeFile(join(evidence, "process.log"), output);
  try {
    await cp(join(data, "logs"), join(evidence, "logs"), { recursive: true });
  } catch (error) {
    if (error.code !== "ENOENT") report.logCopyError = String(error);
  }
  await writeFile(join(evidence, "results.json"), JSON.stringify(report, null, 2));
}
