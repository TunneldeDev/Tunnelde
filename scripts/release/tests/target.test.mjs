import assert from "node:assert/strict";
import { test } from "node:test";
import { releaseTarget, readReleaseTarget, TARGET_PATH } from "../planning/target.mjs";

const declaration = { schemaVersion: 1, baseVersion: "0.38.0", targetVersion: "1.0.0" };

test("reviewed target applies to one stable baseline and expires after promotion", () => {
  assert.equal(releaseTarget("0.38.0", declaration), "1.0.0");
  assert.equal(releaseTarget("1.0.0", declaration), undefined);
  assert.equal(releaseTarget("1.0.1", declaration), undefined);
  assert.equal(releaseTarget("2.0.0", declaration), undefined);
  assert.throws(() => releaseTarget("0.38.1", declaration), /baseline changed/);
  assert.throws(() => releaseTarget("0.37.0", declaration), /baseline changed/);
});

test("targets reject malformed declarations, noncanonical versions and rollback", () => {
  for (const value of [
    null,
    [],
    "1.0.0",
    {},
    { ...declaration, extra: true },
    { ...declaration, schemaVersion: 2 },
  ])
    assert.throws(() => releaseTarget("0.38.0", value), /declaration/);
  for (const version of [
    "v1.0.0",
    "01.0.0",
    "1.00.0",
    "1.0",
    "1.0.0-beta.1",
    "1.0.0+build",
    "1.0.0\n",
    1,
    null,
  ])
    for (const field of ["baseVersion", "targetVersion"])
      assert.throws(() => releaseTarget("0.38.0", { ...declaration, [field]: version }));
  for (const targetVersion of ["0.38.0", "0.37.0"])
    assert.throws(() => releaseTarget("0.38.0", { ...declaration, targetVersion }), /newer/);
  assert.throws(() => releaseTarget("0.38.0-beta.2", declaration));
});

test("target reads stay pinned to source and only a missing file uses automatic planning", async () => {
  const source = "a".repeat(40);
  const repo = { owner: "TunneldeDev", repo: "Tunnelde" };
  const github = {
    rest: {
      repos: {
        getContent: async (args) => {
          assert.deepEqual(args, { ...repo, path: TARGET_PATH, ref: source });
          return {
            data: {
              type: "file",
              encoding: "base64",
              content: Buffer.from(JSON.stringify(declaration)).toString("base64"),
            },
          };
        },
      },
    },
  };
  assert.equal(await readReleaseTarget(github, repo, source, "0.38.0"), "1.0.0");
  for (const status of [404, 403]) {
    github.rest.repos.getContent = async () => {
      throw Object.assign(new Error("read failed"), { status });
    };
    if (status === 404)
      assert.equal(await readReleaseTarget(github, repo, source, "0.38.0"), undefined);
    else await assert.rejects(readReleaseTarget(github, repo, source, "0.38.0"), /read failed/);
  }
  github.rest.repos.getContent = async () => ({
    data: { type: "file", encoding: "base64", content: Buffer.from("not JSON").toString("base64") },
  });
  await assert.rejects(readReleaseTarget(github, repo, source, "0.38.0"), SyntaxError);
  await assert.rejects(readReleaseTarget(github, repo, "dev", "0.38.0"), /immutable/);
});
