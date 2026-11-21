import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BETA_ACCEPTANCE_MARKER,
  acceptedBeta,
  acceptBeta,
  assertAcceptedBeta,
  betaCandidates,
} from "../publishing/acceptance.mjs";

const source = "a".repeat(40);
const stable = "b".repeat(40);

test("only published Betas for the target version can be acceptance candidates", () => {
  const releases = [
    { tag_name: "v1.0.0-beta.1", draft: true, prerelease: true, body: BETA_ACCEPTANCE_MARKER },
    { tag_name: "v1.0.0-beta.2", draft: false, prerelease: false, body: BETA_ACCEPTANCE_MARKER },
    { tag_name: "v0.9.0-beta.3", draft: false, prerelease: true, body: BETA_ACCEPTANCE_MARKER },
    { tag_name: "v1.0.0-beta.4", draft: false, prerelease: true, body: "notes" },
    { tag_name: "v1.0.0-beta.5", draft: false, prerelease: true, body: BETA_ACCEPTANCE_MARKER },
  ];
  assert.deepEqual(
    betaCandidates("1.0.0", releases).map((release) => release.tag_name),
    ["v1.0.0-beta.4", "v1.0.0-beta.5"],
  );
  assert.equal(acceptedBeta("1.0.0", releases)?.tag_name, "v1.0.0-beta.5");
});

test("stable acceptance requires a published accepted Beta from the exact product source", async () => {
  const releases = [
    {
      id: 1,
      tag_name: "v1.0.0-beta.1",
      draft: false,
      prerelease: true,
      body: BETA_ACCEPTANCE_MARKER,
    },
  ];
  const github = {
    paginate: async () => releases,
    rest: {
      repos: {
        getContent: async () => ({
          data: {
            type: "file",
            encoding: "base64",
            content: Buffer.from(JSON.stringify({ sourceSha: source })).toString("base64"),
          },
        }),
      },
      git: {
        getRef: async () => ({ data: { object: { type: "commit", sha: "c".repeat(40) } } }),
        getCommit: async () => ({
          data: { message: `chore: release 1.0.0-beta.1\n\nRelease-source: ${source}` },
        }),
      },
    },
  };
  assert.equal(
    await assertAcceptedBeta({
      github,
      repo: { owner: "TunneldeDev", repo: "Tunnelde" },
      stableSha: stable,
      version: "1.0.0",
    }),
    "v1.0.0-beta.1",
  );
  github.rest.git.getCommit = async () => ({
    data: { message: `chore: release 1.0.0-beta.1\n\nRelease-source: ${"d".repeat(40)}` },
  });
  await assert.rejects(
    assertAcceptedBeta({
      github,
      repo: { owner: "TunneldeDev", repo: "Tunnelde" },
      stableSha: stable,
      version: "1.0.0",
    }),
    /requires an accepted/,
  );
});

test("acceptance is idempotent and only edits a published Beta release", async () => {
  const releases = [
    {
      id: 7,
      tag_name: "v1.0.0-beta.1",
      draft: false,
      prerelease: true,
      body: "Notes",
    },
  ];
  const updates = [];
  const github = {
    paginate: async () => releases,
    rest: { repos: { updateRelease: async (args) => updates.push(args) } },
  };
  assert.equal(
    await acceptBeta({
      github,
      context: { repo: { owner: "TunneldeDev", repo: "Tunnelde" } },
      tag: "v1.0.0-beta.1",
    }),
    true,
  );
  assert.match(updates[0].body, /Notes/);
  assert.match(updates[0].body, /tunnelde:beta-accepted/);
  releases[0].body = updates[0].body;
  assert.equal(
    await acceptBeta({
      github,
      context: { repo: { owner: "TunneldeDev", repo: "Tunnelde" } },
      tag: "v1.0.0-beta.1",
    }),
    false,
  );
});
