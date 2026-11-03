import assert from "node:assert/strict";
import { test } from "node:test";
import {
  collectChanges,
  releasePrBody,
  releaseSection,
  renderRelease,
  replacePendingRelease,
  summarizeChanges,
} from "../release-notes.mjs";

const repository = "TunneldeDev/Tunnelde";
const head = "f".repeat(40);
const commit = (n, message, extra = {}) => ({
  sha: n.toString(16).padStart(40, "0"),
  commit: { message },
  author: { login: "author" },
  ...extra,
});
const options = { version: "0.27.0", previousVersion: "0.26.0", date: "2026-11-03", repository };

test("groups meaningful changes, combines duplicates and preserves all references and coauthors", () => {
  const commits = [
    commit(
      1,
      "feat(terminal): add split views (#10)\n\nCo-authored-by: Other <123+other@users.noreply.github.com>",
      { pullRequest: { number: 10, user: { login: "maintainer" } } },
    ),
    commit(2, "feat(terminal): add split views", {
      pullRequest: { number: 11, user: { login: "contributor" } },
    }),
    commit(3, "fix: restore paste"),
    commit(4, "perf: speed up render"),
    commit(5, "refactor: simplify drawing"),
    commit(6, "docs: explain SSH"),
    commit(7, "build: cross compile"),
    commit(8, "ci: require checks"),
    commit(9, "test: cover paste"),
    commit(10, "style: format"),
    commit(11, "chore(main): release 0.26.1"),
    commit(12, "feat(api)!: remove legacy API"),
    commit(13, "chore(deps): update parser"),
  ];
  const result = renderRelease({ ...options, commits });
  assert.equal(result.count, 9);
  for (const category of [
    "不兼容变更 | Breaking changes",
    "新增 | New",
    "改进 | Improved",
    "修复 | Fix",
    "文档 | Docs",
    "构建 | Build",
    "其他 | Other",
  ])
    assert.ok(result.notes.includes(category));
  assert.match(result.notes, /pull\/10/);
  assert.match(result.notes, /pull\/11/);
  assert.match(result.notes, /@other/);
  assert.match(result.notes, /@maintainer/);
  assert.doesNotMatch(result.notes, /users\.noreply|cover paste|chore\(main\)|- format/);
  assert.equal(
    summarizeChanges(commits).find((entry) => entry.title === "add split views").sources.size,
    2,
  );
  assert.equal(
    summarizeChanges(commits).find((entry) => entry.title === "add split views").authors.size,
    3,
  );
});

test("breaking-change footers remain visible even for normally omitted types", () => {
  const result = summarizeChanges([
    commit(1, "test: remove fixture API\n\nBREAKING CHANGE: external fixture API removed"),
  ]);
  assert.equal(result[0].category, "breaking");
});

test("generated content cannot inject HTML, markdown links or unverified contributor handles", () => {
  const result = renderRelease({
    ...options,
    commits: [
      commit(1, "feat: <details> [bad](javascript:alert) *bold*", {
        author: { login: "bad<script>" },
      }),
    ],
  });
  assert.match(result.notes, /&lt;details&gt;/);
  assert.ok(result.notes.includes("\\[bad\\]"));
  assert.doesNotMatch(result.notes, /@bad|\*bold\*/);
});

test("history remains byte-identical and regeneration is deterministic", () => {
  const history =
    "## [0.26.0] - 2026-11-02\r\n\r\n- Existing notes.\r\n\r\n## [0.25.0]\r\n\r\n- Old.\r\n";
  const base = `# Changelog\n\n## [Unreleased]\n\n- Optional curated summary.\n\n${history}`;
  const release = renderRelease({
    ...options,
    commits: [commit(1, "fix: paste")],
    curated: releaseSection(base, "Unreleased").notes,
  });
  const output = replacePendingRelease(base, release);
  assert.equal(output.slice(output.indexOf("## [0.26.0]")), history);
  assert.match(output, /Highlights\n\n- Optional curated summary\./);
  assert.equal(replacePendingRelease(base, release), output);
  assert.equal(releaseSection(output, "0.27.0").notes, release.notes);
  assert.equal(releaseSection(output, "Unreleased").notes, "");
  assert.throws(() => replacePendingRelease(history, release), /Unreleased/);
});

test("rejects invalid ranges and missing versions instead of summarizing unrelated history", () => {
  for (const override of [
    { version: "main" },
    { previousVersion: "../main" },
    { date: "today" },
    { repository: "bad repo" },
  ]) {
    assert.throws(() =>
      renderRelease({ ...options, ...override, commits: [commit(1, "fix: paste")] }),
    );
  }
  assert.throws(() => renderRelease({ ...options, commits: [] }), /No release changes/);
  assert.throws(() => releaseSection("# Changelog", "0.27.0"), /Missing release/);
  assert.throws(() => summarizeChanges([commit(1, "fix: paste", { sha: "bad" })]), /SHA/);
});

test("the short PR body retains the version heading and delimiters required by Release Please", () => {
  const body = releasePrBody("0.27.0", 5, repository, head);
  assert.match(body, /^---\n## 0\.27\.0\n\n/);
  assert.match(body, /归总 5 项变更/);
  assert.ok(body.endsWith("\n---"));
  assert.ok(body.includes(`/blob/${head}/CHANGELOG.md`));
  assert.doesNotMatch(body, /beep|boop|<details>|Checklist/);
});

test("collects every comparison page and associates only actual main merges", async () => {
  const calls = [];
  const all = Array.from({ length: 101 }, (_, index) => commit(index + 1, `fix: issue ${index}`));
  const github = {
    paginate: async (method, args) => method(args),
    rest: {
      repos: {
        compareCommitsWithBasehead: async (args) => {
          calls.push(args);
          return {
            data: {
              status: "ahead",
              total_commits: 101,
              commits: all.slice((args.page - 1) * 100, args.page * 100),
            },
          };
        },
        listPullRequestsAssociatedWithCommit: async ({ commit_sha }) => [
          {
            number: 1,
            merged_at: "date",
            base: { ref: "main", repo: { full_name: "other/fork" } },
            merge_commit_sha: commit_sha,
          },
          {
            number: 2,
            merged_at: "date",
            base: { ref: "dev", repo: { full_name: repository } },
            merge_commit_sha: commit_sha,
          },
          {
            number: 3,
            merged_at: "date",
            base: { ref: "main", repo: { full_name: repository } },
            merge_commit_sha: commit_sha,
          },
        ],
      },
    },
  };
  const changes = await collectChanges({
    github,
    repo: { owner: "TunneldeDev", repo: "Tunnelde" },
    previousVersion: "0.26.0",
    head,
  });
  assert.equal(changes.length, 101);
  assert.deepEqual(
    calls.map((call) => call.page),
    [1, 2],
  );
  assert.ok(calls.every((call) => call.basehead === `v0.26.0...${head}`));
  assert.ok(changes.every((change) => change.pullRequest.number === 3));
});

test("diverged, truncated or duplicate comparison results stop generation", async () => {
  for (const data of [
    { status: "diverged", total_commits: 1, commits: [commit(1, "fix: paste")] },
    { status: "ahead", total_commits: 1, commits: [] },
    {
      status: "ahead",
      total_commits: 2,
      commits: [commit(1, "fix: paste"), commit(1, "fix: paste")],
    },
  ]) {
    const github = { rest: { repos: { compareCommitsWithBasehead: async () => ({ data }) } } };
    await assert.rejects(collectChanges({ github, repo: {}, previousVersion: "0.26.0", head }));
  }
});
