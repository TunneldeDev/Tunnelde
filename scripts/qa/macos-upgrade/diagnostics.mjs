// Read-only evidence from the already guarded, disposable original-package run.
// Observations never relax process ownership or turn a failed update into a pass.
import assert from "node:assert/strict";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";

export function redactDiagnostics(text) {
  return text
    .replace(/https?:\/\/[^\s"<>]+/gi, "<redacted-url>")
    .replace(/\bBearer\s+\S+/gi, "Bearer <redacted>")
    .replace(
      /((?:password|token|secret|capability|api[_-]?key)["']?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,}]+)/gi,
      "$1<redacted>",
    );
}

// Bound memory and reject symlinks, including a symlink in an ancestor. Recheck
// the opened file's identity; these files belong solely to the disposable run.
export async function readEvidenceFile(path, limit, tail = false) {
  assert(Number.isSafeInteger(limit) && limit > 0);
  const before = await lstat(path);
  assert(before.isFile() && !before.isSymbolicLink(), "Expected regular evidence file");
  assert.equal(await realpath(path), path, "Evidence path traverses a link");
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await file.stat();
    assert.equal(info.dev, before.dev);
    assert.equal(info.ino, before.ino);
    assert(info.isFile());
    const count = Math.min(info.size, limit);
    const buffer = Buffer.alloc(count);
    const { bytesRead } = await file.read(buffer, 0, count, tail ? info.size - count : 0);
    return {
      bytes: buffer.subarray(0, bytesRead),
      size: info.size,
      truncated: info.size > limit,
      modifiedAt: info.mtime.toISOString(),
      modifiedMs: info.mtimeMs,
    };
  } finally {
    await file.close();
  }
}

async function captureFiles({ directory, evidence, prefix, limit, maximum, since, accept, match }) {
  try {
    const info = await lstat(directory);
    assert(info.isDirectory() && !info.isSymbolicLink());
    assert.equal(await realpath(directory), directory);
  } catch (error) {
    if (error.code === "ENOENT") return { status: "absent", files: [] };
    throw error;
  }
  const candidates = [];
  let scanned = 0;
  // Fixed known directories, never a recursive home-directory or system scan.
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (++scanned > 512) break;
    if (!entry.isFile() || !accept(entry.name)) continue;
    const info = await lstat(join(directory, entry.name));
    if (info.mtimeMs >= since) candidates.push({ name: entry.name, modified: info.mtimeMs });
  }
  candidates.sort((a, b) => b.modified - a.modified || a.name.localeCompare(b.name));
  const files = [];
  for (const candidate of candidates.slice(0, maximum)) {
    const result = await readEvidenceFile(join(directory, candidate.name), limit, true);
    const text = result.bytes.toString("utf8");
    if (match && !match(text)) continue;
    const name = `${prefix}-${files.length + 1}.log`;
    const redacted = redactDiagnostics(text);
    await writeFile(join(evidence, name), redacted, { mode: 0o600 });
    files.push({
      source: candidate.name,
      evidence: name,
      sourceBytes: result.size,
      capturedBytes: Buffer.byteLength(redacted),
      truncated: result.truncated,
      modifiedAt: result.modifiedAt,
    });
  }
  return {
    status: "captured",
    directory,
    scanned: Math.min(scanned, 512),
    scanLimited: scanned > 512,
    files,
  };
}

export async function collectFailureDiagnostics(runtime) {
  const { report, native, command, binary, bundle, evidence, home } = runtime;
  const result = { schemaVersion: 1, observedAt: new Date().toISOString(), observations: {} };
  const observe = async (name, action) => {
    try {
      result.observations[name] = { status: "observed", value: await action() };
    } catch (error) {
      // Diagnostic failure is separate from the original product/test failure.
      result.observations[name] = {
        status: "unavailable",
        error: redactDiagnostics(String(error)),
      };
    }
  };
  await observe("processes", () => native("diagnose-processes"));
  await observe("installedBinary", async () => {
    const value = await readEvidenceFile(binary, 128 * 1024 * 1024);
    assert(!value.truncated, "Installed binary exceeds diagnostic hash limit");
    return { bytes: value.size, sha256: createHash("sha256").update(value.bytes).digest("hex") };
  });
  await observe("installedVersion", async () => {
    const plist = join(bundle, "Contents/Info.plist");
    await readEvidenceFile(plist, 1024 * 1024);
    return (
      await command("failure-installed-version", "/usr/libexec/PlistBuddy", [
        "-c",
        "Print :CFBundleShortVersionString",
        plist,
      ])
    ).trim();
  });
  await observe("installedSignature", async () => {
    await command("failure-installed-codesign", "/usr/bin/codesign", [
      "--verify",
      "--deep",
      "--strict",
      bundle,
    ]);
    return { verified: true };
  });
  const since = Date.parse(report.startedAt) - 2000;
  assert(Number.isFinite(since));
  // Tauri's macOS app_log_dir = home/Library/Logs/<identifier>. Require this
  // directory to be absent before startup in public.mjs, so it is run-owned.
  await observe("applicationLogs", () =>
    captureFiles({
      directory: join(home, "Library/Logs/dev.tunnelde.app"),
      evidence,
      prefix: "failure-app",
      limit: 512 * 1024,
      maximum: 4,
      since,
      accept: (name) => /^\d{4}-\d{2}-\d{2}(?:\.[\w-]+)?\.tunnelde(?:\.jsonl)?\.log$/.test(name),
    }),
  );
  await observe("crashReports", () =>
    captureFiles({
      directory: join(home, "Library/Logs/DiagnosticReports"),
      evidence,
      prefix: "failure-crash",
      limit: 512 * 1024,
      maximum: 2,
      since,
      accept: (name) => /^tunnelde[-_].*\.(?:ips|crash)$/i.test(name),
      // A same-name report from another bundle is not this run's evidence.
      match: (text) => text.includes(binary) && text.includes("dev.tunnelde.app"),
    }),
  );
  await observe("bundleParent", async () => {
    const parent = dirname(bundle);
    assert.equal(await realpath(parent), parent);
    const entries = await readdir(parent, { withFileTypes: true });
    return entries.slice(0, 32).map((entry) => ({
      name: entry.name,
      directory: entry.isDirectory(),
      symbolicLink: entry.isSymbolicLink(),
    }));
  });
  return result;
}
