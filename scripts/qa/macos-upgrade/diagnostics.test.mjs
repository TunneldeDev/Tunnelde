import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectFailureDiagnostics, readEvidenceFile, redactDiagnostics } from "./diagnostics.mjs";

test("failure diagnostics remain read-only and preserve partial observations after missing restart", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "tunnelde-diagnostics-")));
  try {
    const bundle = join(root, "install/Tunnelde.app");
    const binary = join(bundle, "Contents/MacOS/tunnelde");
    const evidence = join(root, "evidence");
    const logs = join(root, "Library/Logs/dev.tunnelde.app");
    const crashes = join(root, "Library/Logs/DiagnosticReports");
    for (const path of [join(bundle, "Contents/MacOS"), evidence, logs, crashes])
      await mkdir(path, { recursive: true });
    await writeFile(binary, "known-installed-target");
    await writeFile(join(bundle, "Contents/Info.plist"), "plist");
    await writeFile(
      join(logs, "2026-11-16.tunnelde.log"),
      "token=private https://example.test/?secret=private\nStarted",
    );
    await writeFile(join(logs, "unrelated.log"), "must not collect");
    await writeFile(join(crashes, "tunnelde-fixture.ips"), `dev.tunnelde.app ${binary}\nCrash`);
    const report = {
      passed: false,
      otaAccepted: false,
      failure: "original failure",
      startedAt: new Date().toISOString(),
    };
    const calls = [];
    const result = await collectFailureDiagnostics({
      report,
      binary,
      bundle,
      evidence,
      home: root,
      native: async (action) => {
        assert.equal(action, "diagnose-processes");
        return { rawCandidates: [], registeredCandidates: [] };
      },
      command: async (name, executable, args) => {
        calls.push({ name, executable, args });
        if (executable.endsWith("codesign")) throw new Error("Signature check failed");
        assert(executable.endsWith("PlistBuddy"));
        return "1.4.2\n";
      },
    });
    assert.deepEqual(report, {
      passed: false,
      otaAccepted: false,
      failure: "original failure",
      startedAt: report.startedAt,
    });
    assert.equal(result.observations.installedVersion.value, "1.4.2");
    assert.equal(result.observations.installedSignature.status, "unavailable");
    assert.equal(result.observations.installedBinary.value.bytes, 22);
    assert.equal(result.observations.applicationLogs.value.files.length, 1);
    assert.equal(result.observations.crashReports.value.files.length, 1);
    const captured = await readFile(join(evidence, "failure-app-1.log"), "utf8");
    assert(!captured.includes("private"));
    assert(captured.includes("Started"));
    assert.equal(calls.length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bounded capture takes a log tail and refuses a symlink", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "tunnelde-diagnostics-")));
  try {
    const file = join(root, "file.log");
    await writeFile(file, "old-old-tail");
    const result = await readEvidenceFile(file, 4, true);
    assert.equal(result.bytes.toString(), "tail");
    assert(result.truncated);
    const link = join(root, "linked.log");
    // Windows developer-mode symlinks may be unavailable; directory junctions
    // still exercise ancestor refusal without elevated permissions.
    const alias = join(root, "alias");
    await mkdir(join(root, "nested"));
    await writeFile(join(root, "nested/child.log"), "no");
    await symlink(join(root, "nested"), alias, process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(readEvidenceFile(join(alias, "child.log"), 4), /traverses a link/);
    if (process.platform !== "win32") {
      await symlink(file, link);
      await assert.rejects(readEvidenceFile(link, 4), /regular evidence/);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("diagnostic text redacts credentials and URLs", () => {
  const value = redactDiagnostics(
    'password="secret text" token=abc Bearer XYZ https://example.test/path?q=private',
  );
  for (const secret of ["secret text", "abc", "XYZ", "example.test", "private"])
    assert(!value.includes(secret));
});
