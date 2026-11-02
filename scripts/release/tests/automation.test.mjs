import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  assertNoDrafts,
  checkPullRequest,
  ensureDraftTag,
  isReleasePr,
  releasePrNeedsRefresh,
  updateReleasePr,
  validateTitle,
} from "../automation.mjs";
import {
  releasePrBody,
  releaseSection,
  renderRelease,
  replacePendingRelease,
} from "../release-notes.mjs";

const context = {
  repo: { owner: "TunneldeDev", repo: "Tunnelde" },
  runId: 123,
  serverUrl: "https://github.com",
};
const sha = "a".repeat(40);
const baseSha = "b".repeat(40);
const newSha = "c".repeat(40);
const source = {
  sha: "d".repeat(40),
  commit: { message: "fix(terminal): restore paste" },
  author: { login: "contributor" },
};
const baseChangelog =
  "# Changelog\n\n## [Unreleased]\n\n## [0.26.0] - 2026-11-02\n\n- Historical content.\n";
const generated =
  "# Changelog\n\n## [0.26.1](url) (2026-11-03)\n\n- Original.\n\n## [Unreleased]\n\n## [0.26.0] - 2026-11-02\n\n- Historical content.\n";
const summarized = replacePendingRelease(
  baseChangelog,
  renderRelease({
    version: "0.26.1",
    previousVersion: "0.26.0",
    date: "2026-11-03",
    repository: "TunneldeDev/Tunnelde",
    commits: [source],
  }),
);
const repo = { full_name: "TunneldeDev/Tunnelde" };
function pullRequest(overrides = {}) {
  return {
    number: 12,
    title: "fix(terminal): restore paste",
    state: "open",
    head: { ref: "fix/paste", sha, repo },
    base: { ref: "main", repo, sha: baseSha },
    ...overrides,
  };
}
function fixture({
  pr = pullRequest(),
  releases = [],
  tag,
  notes = generated,
  moved = false,
} = {}) {
  const calls = [];
  const github = {
    paginate: async (method, args) => method(args),
    rest: {
      pulls: {
        get: async () => ({ data: moved ? { ...pr, head: { ...pr.head, sha: newSha } } : pr }),
        update: async (args) => calls.push({ body: args }),
        list: async () => [pr].filter(isReleasePr),
      },
      repos: {
        listReleases: async () => releases,
        createCommitStatus: async (args) => calls.push({ status: args }),
        getContent: async ({ path, ref }) => ({
          data: {
            type: "file",
            encoding: "base64",
            sha,
            content: Buffer.from(
              path.endsWith(".json")
                ? JSON.stringify({ ".": ref === baseSha ? "0.26.0" : "0.26.1" })
                : ref === baseSha
                  ? baseChangelog
                  : notes,
            ).toString("base64"),
          },
        }),
        compareCommitsWithBasehead: async () => ({
          data: { status: "ahead", total_commits: 1, commits: [{ ...source }] },
        }),
        listPullRequestsAssociatedWithCommit: async () => [],
        updateRelease: async (args) => calls.push({ release: args }),
      },
      actions: { createWorkflowDispatch: async (args) => calls.push({ dispatch: args }) },
      git: {
        getCommit: async () => ({ data: { tree: { sha } } }),
        createTree: async (args) => {
          calls.push({ tree: args });
          return { data: { sha: newSha } };
        },
        createCommit: async (args) => {
          calls.push({ commit: args });
          return { data: { sha: newSha } };
        },
        updateRef: async (args) => {
          calls.push({ ref: args });
          pr.head.sha = args.sha;
        },
        getRef: async () => {
          if (tag) return { data: { object: tag } };
          throw Object.assign(new Error("Not found"), { status: 404 });
        },
        createRef: async (args) => calls.push({ tag: args }),
      },
    },
  };
  return { github, context, calls };
}

test("accepts conventional PR titles, including release and dependency PRs", () => {
  for (const title of [
    "feat: add a theme",
    "fix(deps): update i18next",
    "build(deps): update lucide",
    "feat(api)!: replace the API",
    "chore(main): release 0.26.1",
    "docs: 更新指南",
    "revert: undo faulty migration",
  ]) {
    assert.doesNotThrow(() => validateTitle(title));
  }
});

test("rejects unclassified, empty and multiline titles", () => {
  for (const title of [
    "Update stuff",
    "Fix: paste",
    "feat:",
    "fix: ",
    "fix: one\nfeat: two",
    "fix(): paste",
  ]) {
    assert.throws(() => validateTitle(title));
  }
});

test("only identifies the release branch in the same repository", () => {
  assert.equal(isReleasePr(pullRequest()), false);
  assert.equal(
    isReleasePr(pullRequest({ head: { ref: "release-please--branches--main", sha, repo } })),
    true,
  );
  assert.equal(
    isReleasePr(
      pullRequest({
        head: { ref: "release-please--branches--main", sha, repo: { full_name: "other/fork" } },
      }),
    ),
    false,
  );
});

test("blocks another draft while allowing recovery of the same tag", () => {
  const releases = [
    { tag_name: "v0.26.1", draft: true },
    { tag_name: "v0.26.0", draft: false },
  ];
  assert.throws(() => assertNoDrafts(releases), /v0.26.1/);
  assert.doesNotThrow(() => assertNoDrafts(releases, "v0.26.1"));
  assert.doesNotThrow(() => assertNoDrafts(releases.slice(1)));
});

test("publishes PR policy status on the PR head, including validation failures", async () => {
  const f = fixture();
  await checkPullRequest({ ...f, number: 12 });
  assert.equal(f.calls[0].status.sha, sha);
  assert.equal(f.calls[0].status.state, "success");
  const bad = fixture({ pr: pullRequest({ title: "bad title" }) });
  await assert.rejects(checkPullRequest({ ...bad, number: 12 }), /Conventional/);
  assert.equal(bad.calls[0].status.state, "failure");
});

test("draft release blocks the release PR but permits unrelated fixes", async () => {
  const releases = [{ draft: true, tag_name: "v0.26.1" }];
  const release = fixture({
    releases,
    pr: pullRequest({ head: { ref: "release-please--branches--main", sha, repo } }),
  });
  await assert.rejects(checkPullRequest({ ...release, number: 12 }), /existing draft/);
  const normal = fixture({ releases });
  await checkPullRequest({ ...normal, number: 12 });
  assert.equal(normal.calls[0].status.state, "success");
});

test("summarizes only on the release branch before dispatching its actual head", async () => {
  const f = fixture({
    pr: pullRequest({ head: { ref: "release-please--branches--main", sha, repo } }),
  });
  await updateReleasePr(f);
  assert.deepEqual(
    f.calls.map((call) => Object.keys(call)[0]),
    ["tree", "commit", "ref", "body", "status", "dispatch"],
  );
  assert.deepEqual(f.calls[0].tree.tree, [
    { path: "CHANGELOG.md", mode: "100644", type: "blob", content: summarized },
  ]);
  assert.deepEqual(f.calls[1].commit.parents, [sha]);
  assert.equal(f.calls[2].ref.ref, "heads/release-please--branches--main");
  assert.equal(f.calls[2].ref.force, false);
  assert.equal(f.calls[3].body.body, releasePrBody("0.26.1", 1, "TunneldeDev/Tunnelde", newSha));
  assert.equal(f.calls[4].status.sha, newSha);
  assert.equal(f.calls[5].dispatch.ref, "release-please--branches--main");
});

test("regeneration does not create redundant commits or edit the PR body", async () => {
  const pr = pullRequest({
    head: { ref: "release-please--branches--main", sha, repo },
    body: releasePrBody("0.26.1", 1, "TunneldeDev/Tunnelde", sha),
  });
  const f = fixture({ pr, notes: summarized });
  await updateReleasePr(f);
  assert.deepEqual(
    f.calls.map((call) => Object.keys(call)[0]),
    ["status", "dispatch"],
  );
});

test("unchanged source skips Release Please regeneration and preserves the summarized branch", async () => {
  const f = fixture({
    pr: pullRequest({ head: { ref: "release-please--branches--main", sha, repo } }),
  });
  f.github.rest.git.getCommit = async () => ({
    data: { message: `chore(main): release 0.26.1\n\nRelease-source: ${baseSha}` },
  });
  assert.equal(await releasePrNeedsRefresh(f), false);
  f.github.rest.git.getCommit = async () => ({
    data: { message: `chore(main): release 0.26.1\n\nRelease-source: ${sha}` },
  });
  assert.equal(await releasePrNeedsRefresh(f), true);
  assert.equal(await releasePrNeedsRefresh(fixture()), true);
  assert.deepEqual(f.calls, []);
});

test("a concurrently moved release PR is never overwritten", async () => {
  const f = fixture({
    moved: true,
    pr: pullRequest({ head: { ref: "release-please--branches--main", sha, repo } }),
  });
  await assert.rejects(updateReleasePr(f), /moved/);
  assert.deepEqual(f.calls, []);
});

test("a non-fast-forward update failure prevents metadata updates and CI dispatch", async () => {
  const f = fixture({
    pr: pullRequest({ head: { ref: "release-please--branches--main", sha, repo } }),
  });
  f.github.rest.git.updateRef = async () => {
    throw new Error("Not a fast forward");
  };
  await assert.rejects(updateReleasePr(f), /fast forward/);
  assert.deepEqual(
    f.calls.map((call) => Object.keys(call)[0]),
    ["tree", "commit"],
  );
});

test("creates a source tag only for a single matching draft and immutable commit", async () => {
  const releases = [{ id: 42, tag_name: "v0.26.1", draft: true, target_commitish: sha }];
  const f = fixture({ releases });
  await ensureDraftTag({ ...f, tag: "v0.26.1", sha });
  assert.equal(f.calls[0].release.body, releaseSection(generated, "0.26.1").notes);
  assert.equal(f.calls[0].release.release_id, 42);
  assert.equal(f.calls[1].tag.sha, sha);
  const existing = fixture({
    releases: [{ ...releases[0], body: releaseSection(generated, "0.26.1").notes }],
    tag: { type: "commit", sha },
  });
  await ensureDraftTag({ ...existing, tag: "v0.26.1", sha });
  assert.equal(existing.calls.length, 0);
});

test("refuses to retag or overwrite published, duplicate or mismatched releases", async () => {
  for (const releases of [
    [],
    [{ tag_name: "v0.26.1", draft: false, target_commitish: sha }],
    [{ tag_name: "v0.26.1", draft: true, target_commitish: "main" }],
    Array(2).fill({ tag_name: "v0.26.1", draft: true, target_commitish: sha }),
  ]) {
    const f = fixture({ releases });
    await assert.rejects(ensureDraftTag({ ...f, tag: "v0.26.1", sha }), /Expected one draft/);
    assert.equal(f.calls.length, 0);
  }
  const f = fixture({
    releases: [{ tag_name: "v0.26.1", draft: true, target_commitish: sha }],
    tag: { type: "commit", sha: "b".repeat(40) },
  });
  await assert.rejects(ensureDraftTag({ ...f, tag: "v0.26.1", sha }), /elsewhere/);
});

test("the required CI contexts match the protected main rule", () => {
  const ruleset = JSON.parse(
    readFileSync(new URL("../../../.github/main-ruleset.json", import.meta.url)),
  );
  assert.equal(ruleset.enforcement, "active");
  assert.deepEqual(ruleset.bypass_actors, []);
  const checks = ruleset.rules.find((r) => r.type === "required_status_checks").parameters;
  assert.equal(checks.strict_required_status_checks_policy, true);
  assert.equal(checks.required_status_checks.length, 7);
  for (const check of checks.required_status_checks) assert.equal(check.integration_id, 15368);
});
