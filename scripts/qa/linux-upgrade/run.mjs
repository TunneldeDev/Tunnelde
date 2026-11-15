import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chmod, mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { applicationEnvironment } from "../local-cli/verify.mjs";
import { releaseVersion, repository } from "../windows-upgrade/assets.mjs";
import { appimageAsset, requireHostedLinux, upgradeTarget } from "./policy.mjs";

requireHostedLinux(process.env, process.platform, process.arch);
releaseVersion(process.env.OTA_SOURCE_TAG);
const targetTag = upgradeTarget(process.env);
const run = promisify(execFile);
const parent = await realpath(process.env.RUNNER_TEMP);
const root = await mkdtemp(join(parent, "tunnelde-linux-ota-"));
const evidence = join(root, "evidence");
await mkdir(evidence);
const report = {
  tag: process.env.OTA_SOURCE_TAG,
  scope: targetTag
    ? "Original public Linux AppImage: native application-initiated signed installation, automatic restart, seeded public settings retention and normal close on disposable Xvfb. Not populated host/history/Profile/plugin/credential migration or physical desktop acceptance."
    : "Unmodified public AppImage in its extraction runtime on disposable Xvfb/AT-SPI. Environment probe only: no update download, install, restart or physical desktop claim.",
};
try {
  const { stdout } = await run("gh", ["api", `repos/${repository}/releases/tags/${report.tag}`], {
    timeout: 45000,
    maxBuffer: 4 * 1024 * 1024,
  });
  const asset = appimageAsset(JSON.parse(stdout), report.tag);
  report.asset = asset;
  await run(
    "gh",
    [
      "release",
      "download",
      report.tag,
      "--repo",
      repository,
      "--pattern",
      asset.name,
      "--dir",
      root,
    ],
    { timeout: 120000 },
  );
  const binary = join(root, asset.name);
  const bytes = await readFile(binary);
  assert.equal(bytes.length, asset.size);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), asset.sha256);
  await chmod(binary, 0o700);
  const env = applicationEnvironment({
    OTA_PROBE_ROOT: root,
    OTA_PROBE_BINARY: binary,
    OTA_PROBE_VERSION: report.tag.slice(1),
  });
  if (targetTag) {
    const { stdout } = await run("gh", ["api", `repos/${repository}/releases/tags/${targetTag}`], {
      timeout: 45000,
      maxBuffer: 4 * 1024 * 1024,
    });
    report.targetAsset = appimageAsset(JSON.parse(stdout), targetTag);
    env.OTA_TARGET_VERSION = targetTag.slice(1);
    env.OTA_TARGET_SHA256 = report.targetAsset.sha256;
  } else {
    delete env.OTA_TARGET_VERSION;
    delete env.OTA_TARGET_SHA256;
  }
  const probe = await run("/usr/bin/python3", [resolve("scripts/qa/linux-upgrade/probe.py")], {
    env,
    timeout: targetTag ? 420000 : 180000,
    maxBuffer: 2 * 1024 * 1024,
  });
  await writeFile(join(evidence, "probe.stdout.log"), probe.stdout);
  await writeFile(join(evidence, "probe.stderr.log"), probe.stderr);
  report.probe = JSON.parse(await readFile(join(evidence, "gui-probe.json"), "utf8"));
  assert.equal(report.probe.passed, true);
} catch (error) {
  report.failure = String(error?.stack ?? error);
  if (error.stdout) await writeFile(join(evidence, "probe.stdout.log"), error.stdout);
  if (error.stderr) await writeFile(join(evidence, "probe.stderr.log"), error.stderr);
  process.exitCode = 1;
} finally {
  await writeFile(join(evidence, "results.json"), JSON.stringify(report, null, 2));
}
