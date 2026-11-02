import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  assertNoDrafts,
  checkPullRequest,
  ensureDraftTag,
  foldCuratedNotes,
  isReleasePr,
  updateReleasePr,
  validateTitle,
} from "../automation.mjs";

const context = {
  repo: { owner: "TunneldeDev", repo: "Tunnelde" },
  runId: 123,
  serverUrl: "https://github.com",
};
const sha = "a".repeat(40);
const repo = { full_name: "TunneldeDev/Tunnelde" };
function pullRequest(overrides = {}) {
  return {
    number: 12,
    title: "fix(terminal): restore paste",
    state: "open",
    head: { ref: "fix/paste", sha, repo },
    base: { ref: "main", repo },
    ...overrides,
  };
}
function fixture({ pr = pullRequest(), releases = [], tag, notes } = {}) {
  const calls = [];
  const github = {
    paginate: async (method) => method(),
    rest: {
      pulls: {
        get: async () => ({ data: pr }),
        list: async () => [pr].filter(isReleasePr),
      },
      repos: {
        listReleases: async () => releases,
        createCommitStatus: async (args) => calls.push({ status: args }),
        getContent: async ({ path }) => ({
          data: {
            sha,
            content: Buffer.from(
              path.endsWith(".json") ? JSON.stringify({ ".": "0.26.1" }) : notes,
            ).toString("base64"),
          },
        }),
        createOrUpdateFileContents: async (args) => calls.push({ content: args }),
      },
      actions: { createWorkflowDispatch: async (args) => calls.push({ dispatch: args }) },
      git: {
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

const changelog =
  "# Changelog\n\n## [Unreleased]\n\n### Build\n\n- Curated detail.\n\n## [0.26.1](https://github.com/a/b/compare/v0.26.0...v0.26.1) (2026-11-03)\n\n### Build\n\n* Generated entry\n\n## [0.26.0] - 2026-11-02\n\n- Historical content.\n";

test("preserves curated notes inside the new release and keeps history untouched", () => {
  const updated = foldCuratedNotes(changelog, "0.26.1");
  assert.match(updated, /\[Unreleased\]\n\n## \[0\.26\.1\]/);
  assert.match(updated, /Maintainer notes\n\n### Build\n\n- Curated detail/);
  assert.equal(
    updated.slice(updated.indexOf("## [0.26.0]")),
    changelog.slice(changelog.indexOf("## [0.26.0]")),
  );
  assert.equal(foldCuratedNotes(updated, "0.26.1"), updated);
});

test("rejects unexpected changelog structure instead of attaching notes to an old version", () => {
  assert.throws(() => foldCuratedNotes(changelog, "0.27.0"), /Missing first release/);
  assert.throws(() => foldCuratedNotes("# Changelog", "0.26.1"), /Unreleased/);
  assert.throws(() => foldCuratedNotes(changelog, "main"), /version/);
});

test("handles Release Please inserting the generated version above Unreleased", () => {
  const input =
    "# Changelog\n\n## [0.26.1](url) (2026-11-03)\n\n### Build\n\n* Generated.\n\n## [Unreleased]\n\n- Curated.\n\n## [0.26.0] - 2026-11-02\n\n- History.\n";
  const result = foldCuratedNotes(input, "0.26.1");
  assert.match(result, /^# Changelog\n\n## \[Unreleased\]\n\n## \[0\.26\.1\]/);
  assert.match(result, /Maintainer notes\n\n- Curated\./);
  assert.ok(result.includes("* Generated."));
  assert.ok(result.endsWith("## [0.26.0] - 2026-11-02\n\n- History.\n"));
  assert.equal(foldCuratedNotes(result, "0.26.1"), result);
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

test("updates curated notes before explicitly dispatching CI on the release branch", async () => {
  const f = fixture({
    notes: changelog,
    pr: pullRequest({ head: { ref: "release-please--branches--main", sha, repo } }),
  });
  await updateReleasePr(f);
  assert.deepEqual(
    f.calls.map((call) => Object.keys(call)[0]),
    ["content", "status", "dispatch"],
  );
  assert.equal(f.calls[2].dispatch.ref, "release-please--branches--main");
  assert.equal(f.calls[2].dispatch.workflow_id, "ci.yml");
  assert.equal(f.calls[0].content.sha, sha);
  assert.equal(
    Buffer.from(f.calls[0].content.content, "base64").toString(),
    foldCuratedNotes(changelog, "0.26.1"),
  );
});

test("unchanged release notes do not create redundant commits", async () => {
  const f = fixture({
    notes: foldCuratedNotes(changelog, "0.26.1"),
    pr: pullRequest({ head: { ref: "release-please--branches--main", sha, repo } }),
  });
  await updateReleasePr(f);
  assert.deepEqual(
    f.calls.map((call) => Object.keys(call)[0]),
    ["status", "dispatch"],
  );
});

test("creates a source tag only for a single matching draft and immutable commit", async () => {
  const releases = [{ tag_name: "v0.26.1", draft: true, target_commitish: sha }];
  const f = fixture({ releases });
  await ensureDraftTag({ ...f, tag: "v0.26.1", sha });
  assert.equal(f.calls[0].tag.sha, sha);
  const existing = fixture({ releases, tag: { type: "commit", sha } });
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
