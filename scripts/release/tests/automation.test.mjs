import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  branchSha,
  checkPullRequest,
  ensureRelease,
  maintainReleasePr,
  nextVersion,
  planDevelopment,
  prepareBeta,
  prepareNightly,
  prepareTaggedRelease,
  resolveTag,
  prepareStable,
  publishRelease,
  readText,
  RELEASE_BRANCH,
  SOURCE_PATH,
  validateTitle,
} from "../automation.mjs";
import { VERSION_PATHS, versionContents } from "../version.mjs";

const sha = (letter) => letter.repeat(40);
const main = sha("a"),
  dev = sha("b"),
  baseline = sha("c"),
  generated = sha("d"),
  oldHead = sha("e");
const context = {
  repo: { owner: "TunneldeDev", repo: "Tunnelde" },
  runId: 123,
  serverUrl: "https://github.com",
};
const repo = { full_name: "TunneldeDev/Tunnelde" };
const history =
  "# Changelog\n\n## [Unreleased]\n\n## [0.26.1] - 2026-11-03\n\n- Historical notes.\n";
const source = {
  sha: dev,
  commit: { message: "fix(terminal): restore paste" },
  author: { login: "author" },
};
const versionFiles = versionContents(
  Object.fromEntries(
    VERSION_PATHS.map((path) => [
      path,
      readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8"),
    ]),
  ),
  "0.26.1",
);
const marker = { sourceSha: baseline, baseSha: null, version: "0.26.1" };

function fixture({
  refs = {},
  releases = [],
  commits = [source],
  messages = {},
  prCommits,
  pr,
  gitCommits = {},
  moved = false,
} = {}) {
  const calls = [];
  const contents = new Map();
  const references = { "heads/main": main, "heads/dev": dev, ...refs };
  const files = { ...versionFiles, "CHANGELOG.md": history, [SOURCE_PATH]: JSON.stringify(marker) };
  const pull = {
    commits: pr?.head.ref === RELEASE_BRANCH ? 2 : 1,
    ...(pr || {
      number: 15,
      title: "fix: restore paste",
      state: "open",
      head: { ref: "fix/paste", sha: oldHead, repo },
      base: { ref: "dev", sha: baseline, repo },
    }),
  };
  let comparisons = 0;
  const github = {
    paginate: (method, args) => method(args),
    graphql: async (query, variables) => {
      calls.push({ ready: { query, variables } });
    },
    rest: {
      git: {
        listMatchingRefs: async ({ ref }) => ({
          data: Object.entries(references)
            .filter(([name]) => name.startsWith(ref))
            .map(([name, value]) => ({
              ref: `refs/${name}`,
              object: { type: "commit", sha: value },
            })),
        }),
        getRef: async ({ ref }) => {
          const value = references[ref];
          if (!value) throw Object.assign(new Error("Not found"), { status: 404 });
          return {
            data: {
              object: {
                type: "commit",
                sha: moved && comparisons && ref === "heads/dev" ? sha("f") : value,
              },
            },
          };
        },
        getCommit: async ({ commit_sha }) => ({
          data: gitCommits[commit_sha] ?? {
            tree: { sha: commit_sha },
            parents: (commit_sha === generated ? [main, dev] : [main]).map((sha) => ({ sha })),
            message: messages[commit_sha] ?? `chore: Nightly\n\nRelease-source: ${dev}`,
          },
        }),
        getTree: async () => ({
          data: {
            truncated: false,
            tree: [{ path: "app.ts", mode: "100644", type: "blob", sha: baseline }],
          },
        }),
        createTree: async (args) => {
          calls.push({ tree: args });
          return { data: { sha: generated } };
        },
        createCommit: async (args) => {
          calls.push({ commit: args });
          gitCommits[generated] = {
            tree: { sha: args.tree },
            parents: args.parents.map((sha) => ({ sha })),
            message: args.message,
          };
          for (const entry of calls.findLast((call) => call.tree).tree.tree)
            contents.set(`${generated}:${entry.path}`, entry.content);
          return { data: { sha: generated } };
        },
        createRef: async (args) => {
          calls.push({ createRef: args });
          references[args.ref.replace(/^refs\//, "")] = args.sha;
        },
        updateRef: async (args) => {
          calls.push({ updateRef: args });
          references[args.ref] = args.sha;
        },
      },
      repos: {
        getContent: async ({ path, ref }) => {
          const text = contents.get(`${ref}:${path}`) ?? files[path];
          if (text === undefined) throw Object.assign(new Error("Not found"), { status: 404 });
          return {
            data: {
              type: "file",
              encoding: "base64",
              content: Buffer.from(text).toString("base64"),
            },
          };
        },
        compareCommitsWithBasehead: async (args) => {
          calls.push({ compare: args });
          comparisons++;
          return {
            data: {
              status: commits.length ? "ahead" : "identical",
              total_commits: commits.length,
              commits: globalThis.structuredClone(commits),
            },
          };
        },
        listPullRequestsAssociatedWithCommit: async () => [],
        listReleases: async () => releases,
        createCommitStatus: async (args) => {
          calls.push({ status: args });
        },
        createRelease: async (args) => {
          calls.push({ createRelease: args });
          return { data: { id: 42 } };
        },
        updateRelease: async (args) => {
          calls.push({ publish: args });
        },
        deleteRelease: async (args) => {
          calls.push({ deleteRelease: args });
        },
      },
      pulls: {
        listCommits: async () =>
          prCommits ??
          (pull.head.ref === RELEASE_BRANCH
            ? [source, { sha: generated, commit: { message: "chore(main): release 0.26.2" } }]
            : [{ ...source, sha: references[`heads/${pull.head.ref}`] || pull.head.sha }]),
        list: async () => (pr ? [pr] : []),
        get: async () => ({
          data: {
            ...pull,
            head: { ...pull.head, sha: references[`heads/${pull.head.ref}`] || pull.head.sha },
          },
        }),
        create: async (args) => {
          calls.push({ createPr: args });
          pull.head.ref = args.head;
          pull.base.ref = args.base;
          pull.commits = 2;
          return { data: { number: 15 } };
        },
        update: async (args) => {
          calls.push({ updatePr: args });
        },
      },
      actions: {
        createWorkflowDispatch: async (args) => {
          calls.push({ dispatch: args });
        },
      },
    },
  };
  return { github, context, calls, files, contents, references, gitCommits };
}

test("conventional titles and automatic semantic versioning", () => {
  for (const title of [
    "fix(deps): update parser",
    "feat!: replace API",
    "ci: release",
    "chore(main): release 1.0.1",
  ])
    assert.doesNotThrow(() => validateTitle(title));
  for (const title of ["Update stuff", "fix: ", "feat: one\nfix: two"])
    assert.throws(() => validateTitle(title));
  const changes = (message) => [{ commit: { message } }];
  assert.equal(nextVersion("0.26.1", changes("fix: paste")), "0.26.2");
  assert.equal(nextVersion("0.26.1", changes("feat: themes")), "0.27.0");
  assert.equal(nextVersion("0.26.1", changes("feat!: replace API")), "0.27.0");
  assert.equal(
    nextVersion("1.2.3", changes("fix: replacement\n\nBREAKING CHANGE: remove API")),
    "2.0.0",
  );
  assert.equal(nextVersion("1.2.3", changes("docs: guide")), "1.2.4");
});

test("immutable source reads retry transient GitHub server errors only", async () => {
  const f = fixture();
  const original = f.github.rest.repos.getContent;
  const delays = [];
  let reads = 0;
  f.github.rest.repos.getContent = async (args) => {
    if (++reads <= 2) throw Object.assign(new Error("Gateway timeout"), { status: 504 });
    return original(args);
  };
  assert.equal(
    await readText(f.github, context.repo, "CHANGELOG.md", dev, async (ms) => delays.push(ms)),
    history,
  );
  assert.deepEqual(delays, [1000, 2000]);
  for (const status of [400, 401, 403, 404, 422, 500, 502, 503, 504]) {
    reads = 0;
    f.github.rest.repos.getContent = async () => {
      reads++;
      throw Object.assign(new Error("Read failed"), { status });
    };
    await assert.rejects(
      readText(f.github, context.repo, "CHANGELOG.md", dev, async () => {}),
      /Read failed/,
    );
    assert.equal(reads, status >= 500 ? 4 : 1);
  }
});

test("stable and beta transforms update all eight versions, are idempotent, and reject missing metadata", () => {
  for (const version of ["0.26.2", "0.26.2-beta.1", "0.26.2-beta.2"]) {
    const updated = versionContents(versionFiles, version);
    for (const path of VERSION_PATHS) assert.ok(updated[path].includes(version), path);
    assert.deepEqual(versionContents(updated, version), updated);
  }
  assert.throws(() => versionContents(versionFiles, "nightly"), /invalid version/);
  assert.throws(
    () => versionContents({ ...versionFiles, "src-tauri/Cargo.lock": "missing" }, "0.26.2"),
    /locate version/,
  );
});

test("release plans use authoritative heads and last promoted dev SHA across squash releases", async () => {
  const f = fixture();
  const plan = await planDevelopment(f);
  assert.equal(plan.main, main);
  assert.equal(plan.dev, dev);
  assert.equal(plan.version, "0.26.2");
  assert.equal(f.calls[0].compare.basehead, `${baseline}...${dev}`);
  assert.ok(plan.history.endsWith("- Historical notes.\n"));
  f.files[SOURCE_PATH] = JSON.stringify({ ...marker, sourceSha: dev, baseSha: baseline });
  f.github.rest.repos.compareCommitsWithBasehead = async (args) => {
    assert.equal(args.basehead, `${dev}...${dev}`);
    return { data: { status: "identical", total_commits: 0, commits: [] } };
  };
  assert.equal((await planDevelopment(f)).version, undefined);
});

test("release highlights ignore an unchanged promoted summary and retain a newly edited one", async () => {
  const f = fixture();
  const withSummary = (summary) =>
    history.replace("## [Unreleased]\n", `## [Unreleased]\n\n${summary}\n`);
  f.contents.set(`${baseline}:CHANGELOG.md`, withSummary("- Previous release summary."));
  f.contents.set(
    `${dev}:CHANGELOG.md`,
    withSummary("- Previous release summary.").replace(/\n/g, "\r\n"),
  );
  const unchanged = await planDevelopment(f);
  assert.match(unchanged.release.notes, /Highlights\n\n- \*\*terminal:\*\* restore paste/);
  assert.doesNotMatch(unchanged.release.notes, /Previous release summary/);

  f.contents.set(`${dev}:CHANGELOG.md`, withSummary("- New release summary."));
  const edited = await planDevelopment(f);
  assert.match(edited.release.notes, /Highlights\n\n- New release summary\./);
  assert.doesNotMatch(edited.release.notes, /Previous release summary/);

  f.contents.set(`${dev}:CHANGELOG.md`, history);
  assert.match(
    (await planDevelopment(f)).release.notes,
    /Highlights\n\n- \*\*terminal:\*\* restore paste/,
  );
});

test("migration waits for main metadata, and an identical source creates no release", async () => {
  const f = fixture({ commits: [] });
  assert.equal((await planDevelopment(f)).version, undefined);
  delete f.files[SOURCE_PATH];
  assert.equal((await planDevelopment(f)).version, undefined);
});

test("refuses to discard main changes outside generated metadata", async () => {
  const f = fixture();
  f.files[SOURCE_PATH] = JSON.stringify({ ...marker, baseSha: baseline });
  f.github.rest.git.getTree = async ({ tree_sha }) => ({
    data: {
      tree: [{ type: "blob", mode: "100644", path: "app.ts", sha: tree_sha }],
      truncated: false,
    },
  });
  await assert.rejects(planDevelopment(f), /merge main into dev/);
  f.github.rest.git.getTree = async () => ({ data: { tree: [], truncated: true } });
  await assert.rejects(planDevelopment(f), /truncated/);
});

test("hotfix protection permits main changes already incorporated into dev", async () => {
  const f = fixture();
  f.files[SOURCE_PATH] = JSON.stringify({ ...marker, baseSha: baseline });
  f.github.rest.git.getTree = async ({ tree_sha }) => ({
    data: {
      truncated: false,
      tree: [
        {
          type: "blob",
          mode: "100644",
          path: "app.ts",
          sha: tree_sha === baseline ? baseline : main,
        },
      ],
    },
  });
  assert.equal((await planDevelopment(f)).version, "0.26.2");
});

test("Beta reruns reuse their immutable tag rather than creating another commit", async () => {
  const tag = "v0.26.2-beta.1";
  const f = fixture({
    refs: { [`tags/${tag}`]: generated },
    releases: [{ tag_name: tag, target_commitish: generated, prerelease: true, draft: true }],
  });
  const plan = await planDevelopment(f);
  assert.equal(await prepareBeta({ ...f, plan }), tag);
  assert.equal(
    f.calls.some((call) => call.commit),
    false,
  );
});

test("promotion tree retains both main and original dev history without modifying either branch", async () => {
  const f = fixture();
  const plan = await planDevelopment(f);
  await maintainReleasePr({ ...f, plan });
  const tree = f.calls.find((call) => call.tree).tree;
  assert.equal(tree.base_tree, dev);
  const notes = tree.tree.find((entry) => entry.path === "CHANGELOG.md").content;
  assert.ok(notes.includes("## [0.26.2]"));
  assert.ok(notes.endsWith("## [0.26.1] - 2026-11-03\n\n- Historical notes.\n"));
  assert.deepEqual(f.calls.find((call) => call.commit).commit.parents, [main, dev]);
  assert.deepEqual(JSON.parse(f.contents.get(`${generated}:${SOURCE_PATH}`)), {
    sourceSha: dev,
    baseSha: main,
    version: "0.26.2",
    history: "merge",
  });
  assert.equal(f.references["heads/main"], main);
  assert.equal(f.references["heads/dev"], dev);
  assert.equal(f.calls.find((call) => call.createPr).createPr.base, "main");
  assert.equal(f.calls.at(-1).dispatch.ref, RELEASE_BRANCH);
});

test("moving main/dev during preparation never mutates a branch or dispatches checks", async () => {
  const f = fixture({ moved: true });
  const plan = await planDevelopment(f);
  await assert.rejects(maintainReleasePr({ ...f, plan }), /dev moved/);
  assert.equal(
    f.calls.some((call) => call.createRef || call.updateRef || call.createPr || call.dispatch),
    false,
  );
});

test("release policy ignores stale PR base.sha and resolves actual main/dev refs", async () => {
  const pr = {
    number: 15,
    title: "chore(main): release 0.26.2",
    state: "open",
    head: { ref: RELEASE_BRANCH, sha: generated, repo },
    base: { ref: "main", sha: baseline, repo },
  };
  const f = fixture({ pr });
  f.contents.set(
    `${generated}:${SOURCE_PATH}`,
    JSON.stringify({ baseSha: main, sourceSha: dev, version: "0.26.2", history: "merge" }),
  );
  await checkPullRequest({ ...f, number: 15 });
  assert.equal(f.calls.at(-1).status.state, "success");
  f.references["heads/main"] = sha("f");
  await assert.rejects(checkPullRequest({ ...f, number: 15 }), /main moved/);
  assert.equal(f.calls.at(-1).status.state, "failure");
});

test("contributions target dev, and invalid titles fail on the actual head", async () => {
  const f = fixture();
  await checkPullRequest({ ...f, number: 15 });
  assert.equal(f.calls.at(-1).status.sha, oldHead);
  const pr = {
    number: 15,
    title: "fix: hotfix",
    state: "open",
    head: { ref: "fix/a", sha: oldHead, repo },
    base: { ref: "main", sha: baseline, repo },
  };
  const bad = fixture({ pr });
  await assert.rejects(checkPullRequest({ ...bad, number: 15 }), /Contributions target dev/);
});

test("PR policy validates all retained subjects while allowing commit bodies and trailers", async () => {
  const f = fixture({
    pr: {
      number: 15,
      title: "feat: improve sessions",
      state: "open",
      commits: 3,
      head: { ref: "feat/sessions", sha: oldHead, repo },
      base: { ref: "dev", sha: main, repo },
    },
    prCommits: [
      { sha: baseline, commit: { message: "feat(sessions): add profiles\n\nAn explanation." } },
      {
        sha: dev,
        commit: { message: "fix: handle reconnect\n\nCo-authored-by: Other <other@example.com>" },
      },
      {
        sha: oldHead,
        commit: { message: "refactor(api)!: replace sessions\n\nBREAKING CHANGE: remove old API" },
      },
    ],
  });
  await checkPullRequest({ ...f, number: 15 });
  assert.equal(f.calls.at(-1).status.state, "success");
  assert.match(f.calls.at(-1).status.description, /all 3 commit subjects/);
});

test("a valid PR title cannot hide invalid intermediate commits before rebase merging", async () => {
  const f = fixture({
    pr: {
      number: 15,
      title: "fix: reconnect",
      state: "open",
      commits: 2,
      head: { ref: "fix/reconnect", sha: oldHead, repo },
      base: { ref: "dev", sha: main, repo },
    },
    prCommits: [
      { sha: baseline, commit: { message: "fixup! try again" } },
      { sha: oldHead, commit: { message: "fix: reconnect" } },
    ],
  });
  await assert.rejects(
    checkPullRequest({ ...f, number: 15 }),
    /Conventional Commit subjects: ccccccc/,
  );
  assert.equal(f.calls.at(-1).status.state, "failure");
  assert.equal(f.calls.at(-1).status.sha, oldHead);
});

test("PR policy rejects truncated, changed and duplicate commit history", async () => {
  for (const [count, prCommits] of [
    [1, []],
    [1, [{ ...source, sha: dev }]],
    [
      2,
      [
        { ...source, sha: oldHead },
        { ...source, sha: oldHead },
      ],
    ],
    [251, [{ ...source, sha: oldHead }]],
  ]) {
    const f = fixture({
      pr: {
        number: 15,
        title: "fix: reconnect",
        state: "open",
        commits: count,
        head: { ref: "fix/reconnect", sha: oldHead, repo },
        base: { ref: "dev", sha: main, repo },
      },
      prCommits,
    });
    await assert.rejects(
      checkPullRequest({ ...f, number: 15, wait: async () => {} }),
      /Incomplete or changed/,
    );
    assert.equal(f.calls.at(-1).status.state, "failure");
  }
});

test("PR checks recover when metadata and commit lists converge after a ref update", async () => {
  const f = fixture();
  const originalGet = f.github.rest.pulls.get;
  let reads = 0;
  let lists = 0;
  const delays = [];
  f.github.rest.pulls.get = async (...args) => {
    const result = await originalGet(...args);
    reads++;
    if (reads === 1) result.data.head.sha = baseline;
    if (reads === 2) result.data.commits = 2;
    return result;
  };
  f.github.rest.pulls.listCommits = async () => {
    lists++;
    return [{ ...source, sha: lists === 1 ? baseline : oldHead }];
  };
  await checkPullRequest({
    ...f,
    number: 15,
    expectedHead: oldHead,
    wait: async (ms) => delays.push(ms),
  });
  assert.deepEqual(delays, [1000, 2000]);
  assert.equal(reads, 3);
  assert.equal(f.calls.at(-1).status.state, "success");
  assert.equal(f.calls.at(-1).status.sha, oldHead);
});

test("consistent but stale snapshots never approve a different generated head", async () => {
  const f = fixture();
  const delays = [];
  await assert.rejects(
    checkPullRequest({
      ...f,
      number: 15,
      expectedHead: generated,
      wait: async (ms) => delays.push(ms),
    }),
    /Incomplete or changed/,
  );
  assert.deepEqual(delays, [1000, 2000, 4000]);
  assert.equal(f.calls.at(-1).status.state, "failure");
});

test("invalid subjects are still rejected after a stale snapshot recovers", async () => {
  const f = fixture();
  let reads = 0;
  f.github.rest.pulls.listCommits = async () =>
    ++reads === 1 ? [] : [{ ...source, sha: oldHead, commit: { message: "fixup! unfinished" } }];
  await assert.rejects(
    checkPullRequest({ ...f, number: 15, wait: async () => {} }),
    /Conventional Commit subjects/,
  );
  assert.equal(f.calls.at(-1).status.state, "failure");
});

test("unchanged generated release PRs redispatch CI when recovering an interrupted workflow", async () => {
  const pr = {
    number: 15,
    title: "chore(main): release 0.26.2",
    state: "open",
    head: { ref: RELEASE_BRANCH, sha: generated, repo },
    base: { ref: "main", sha: main, repo },
  };
  const f = fixture({ pr, refs: { [`heads/${RELEASE_BRANCH}`]: generated } });
  f.contents.set(
    `${generated}:${SOURCE_PATH}`,
    JSON.stringify({ baseSha: main, sourceSha: dev, version: "0.26.2", history: "merge" }),
  );
  await maintainReleasePr({ ...f, plan: await planDevelopment(f) });
  assert.deepEqual(
    f.calls.filter((call) => !call.compare).map((call) => Object.keys(call)[0]),
    ["status", "dispatch"],
  );
  assert.equal(f.calls.at(-1).dispatch.ref, RELEASE_BRANCH);
});

test("generated release PRs retain individual dev commits and validate their actual parents", async () => {
  const f = fixture({
    pr: {
      number: 15,
      title: "chore(main): release 0.26.2",
      state: "open",
      commits: 2,
      head: { ref: RELEASE_BRANCH, sha: generated, repo },
      base: { ref: "main", sha: main, repo },
    },
    prCommits: [
      { ...source, sha: baseline },
      { ...source, sha: generated },
    ],
  });
  f.contents.set(
    `${generated}:${SOURCE_PATH}`,
    JSON.stringify({ baseSha: main, sourceSha: dev, version: "0.26.2", history: "merge" }),
  );
  await checkPullRequest({ ...f, number: 15 });
  assert.equal(f.calls.at(-1).status.state, "success");
  for (const parents of [[main], [dev], [dev, main], [main, baseline]]) {
    f.gitCommits[generated] = {
      tree: { sha: generated },
      parents: parents.map((sha) => ({ sha })),
    };
    await assert.rejects(
      checkPullRequest({ ...f, number: 15 }),
      /retain the reviewed main and dev/,
    );
    assert.equal(f.calls.at(-1).status.state, "failure");
  }
});

test("release policy rejects legacy squashed preparations and source changes outside metadata", async () => {
  const f = fixture({
    pr: {
      number: 15,
      title: "chore(main): release 0.26.2",
      state: "open",
      head: { ref: RELEASE_BRANCH, sha: generated, repo },
      base: { ref: "main", sha: main, repo },
    },
  });
  f.contents.set(
    `${generated}:${SOURCE_PATH}`,
    JSON.stringify({ baseSha: main, sourceSha: dev, version: "0.26.2" }),
  );
  await assert.rejects(checkPullRequest({ ...f, number: 15 }), /regenerated/);
  f.contents.set(
    `${generated}:${SOURCE_PATH}`,
    JSON.stringify({ baseSha: main, sourceSha: dev, version: "0.26.2", history: "merge" }),
  );
  f.github.rest.git.getTree = async ({ tree_sha }) => ({
    data: {
      truncated: false,
      tree: [{ path: "app.ts", type: "blob", mode: "100644", sha: tree_sha }],
    },
  });
  await assert.rejects(checkPullRequest({ ...f, number: 15 }), /outside metadata \(app.ts\)/);
  f.github.rest.git.getTree = async () => ({ data: { tree: [], truncated: true } });
  await assert.rejects(checkPullRequest({ ...f, number: 15 }), /truncated/);
});

test("legacy release branches are rebuilt even when their source markers are current", async () => {
  const f = fixture({
    refs: { [`heads/${RELEASE_BRANCH}`]: oldHead },
    pr: {
      number: 15,
      title: "chore(main): release 0.26.2",
      state: "open",
      head: { ref: RELEASE_BRANCH, sha: oldHead, repo },
      base: { ref: "main", sha: main, repo },
    },
  });
  f.contents.set(`${oldHead}:${SOURCE_PATH}`, JSON.stringify({ baseSha: main, sourceSha: dev }));
  await maintainReleasePr({ ...f, plan: await planDevelopment(f) });
  assert.deepEqual(f.calls.find((call) => call.commit).commit.parents, [main, dev]);
  assert.equal(f.calls.find((call) => call.updateRef).updateRef.ref, `heads/${RELEASE_BRANCH}`);
});

test("an old release draft is reopened only after history-preserving regeneration passes policy", async () => {
  const f = fixture({
    refs: { [`heads/${RELEASE_BRANCH}`]: oldHead },
    pr: {
      number: 15,
      node_id: "PR_migration",
      draft: true,
      title: "chore(main): release 0.26.2",
      state: "open",
      head: { ref: RELEASE_BRANCH, sha: oldHead, repo },
      base: { ref: "main", sha: main, repo },
    },
  });
  f.contents.set(`${oldHead}:${SOURCE_PATH}`, JSON.stringify({ baseSha: main, sourceSha: dev }));
  await maintainReleasePr({ ...f, plan: await planDevelopment(f) });
  assert.equal(f.calls.at(-1).ready.variables.id, "PR_migration");
  assert.equal(f.calls.at(-2).dispatch.ref, RELEASE_BRANCH);
});

test("rebased batches choose the highest semantic bump from retained commits", () => {
  const changes = (messages) => messages.map((message) => ({ commit: { message } }));
  assert.equal(
    nextVersion("0.26.1", changes(["fix: reconnect", "feat: sessions", "docs: usage"])),
    "0.27.0",
  );
  assert.equal(
    nextVersion(
      "1.2.3",
      changes(["feat: sessions", "fix(api)!: replace transport", "docs: usage"]),
    ),
    "2.0.0",
  );
  assert.equal(nextVersion("1.2.3", changes(["docs: usage", "fix: reconnect"])), "1.2.4");
});

test("merge settings retain linear contributions and preserve original history in stable promotions", () => {
  const settings = JSON.parse(
    readFileSync(new URL("../../../.github/repository-settings.json", import.meta.url)),
  );
  assert.equal(settings.allow_rebase_merge, true);
  assert.equal(settings.allow_squash_merge, true);
  assert.equal(settings.allow_merge_commit, true);
  for (const [branch, methods] of [
    ["dev", ["squash", "rebase"]],
    ["main", ["merge"]],
  ]) {
    const ruleset = JSON.parse(
      readFileSync(new URL(`../../../.github/${branch}-ruleset.json`, import.meta.url)),
    );
    assert.deepEqual(
      ruleset.rules.find((rule) => rule.type === "pull_request").parameters.allowed_merge_methods,
      methods,
    );
    assert.equal(
      ruleset.rules.some((rule) => rule.type === "required_linear_history"),
      branch === "dev",
    );
    for (const required of ["deletion", "non_fast_forward", "required_status_checks"])
      assert.ok(ruleset.rules.some((rule) => rule.type === required));
    assert.deepEqual(ruleset.bypass_actors, []);
  }
});

test("tag is created before a draft; stable recovery is idempotent and never moves tags", async () => {
  const f = fixture();
  assert.equal(await ensureRelease({ ...f, tag: "v0.26.2", sha: main, body: "Notes" }), "v0.26.2");
  assert.ok(
    f.calls.findIndex((call) => call.createRef) < f.calls.findIndex((call) => call.createRelease),
  );
  const retry = fixture({
    refs: { "tags/v0.26.2": main },
    releases: [{ tag_name: "v0.26.2", target_commitish: main, prerelease: false, draft: true }],
  });
  assert.equal(
    await ensureRelease({ ...retry, tag: "v0.26.2", sha: main, body: "Notes" }),
    "v0.26.2",
  );
  assert.deepEqual(retry.calls, []);
  retry.references["tags/v0.26.2"] = dev;
  await assert.rejects(
    ensureRelease({ ...retry, tag: "v0.26.2", sha: main, body: "Notes" }),
    /elsewhere/,
  );
});

test("published releases are never rebuilt and channel mismatches are rejected", async () => {
  const f = fixture({
    refs: { "tags/v0.26.2": main },
    releases: [{ tag_name: "v0.26.2", target_commitish: main, prerelease: false, draft: false }],
  });
  assert.equal(await ensureRelease({ ...f, tag: "v0.26.2", sha: main, body: "Notes" }), "");
  await assert.rejects(
    ensureRelease({ ...f, tag: "v0.26.2", sha: main, body: "Notes", prerelease: true }),
    /channel/,
  );
});

test("Beta uses versioned manifests, its own immutable tag and does not become latest stable", async () => {
  const f = fixture();
  const plan = await planDevelopment(f);
  const tag = await prepareBeta({ ...f, plan });
  assert.equal(tag, "v0.26.2-beta.1");
  const release = f.calls.find((call) => call.createRelease).createRelease;
  assert.equal(release.prerelease, true);
  assert.equal(release.make_latest, "false");
  assert.equal(release.name, tag);
  assert.deepEqual(f.calls.find((call) => call.commit).commit.parents, [dev]);
  assert.ok(f.contents.get(`${generated}:CITATION.cff`).includes("0.26.2-beta.1"));
});

test("beta sequences advance numerically using tags even after releases are retired", async () => {
  const f = fixture({
    refs: {
      "tags/v0.26.2-beta.7": baseline,
      "tags/v0.26.2-beta.8": oldHead,
      "tags/v0.26.2-beta.99-invalid": main,
    },
    messages: {
      [baseline]: `Release-source: ${baseline}`,
      [oldHead]: `Release-source: ${oldHead}`,
    },
  });
  assert.equal(await prepareBeta({ ...f, plan: await planDevelopment(f) }), "v0.26.2-beta.9");
  assert.equal(f.references["tags/v0.26.2-beta.8"], oldHead);
});

test("each target stable version starts its own beta sequence at one", async () => {
  for (const version of ["0.26.3", "0.27.0", "1.0.0"]) {
    const f = fixture({ refs: { "tags/v0.26.2-beta.99.2": oldHead } });
    const plan = { ...(await planDevelopment(f)), version };
    assert.equal(await prepareBeta({ ...f, plan }), `v${version}-beta.1`);
  }
});

test("beta.9 can be retried but a new source cannot allocate beta.10 or recycle historical numbers", async () => {
  for (const suffix of [".9", ".10", ".11", "12", ".99.2"]) {
    const tag = `v0.26.2-beta${suffix}`;
    const f = fixture({
      refs: { [`tags/${tag}`]: oldHead },
      messages: { [oldHead]: `Release-source: ${oldHead}` },
    });
    await assert.rejects(
      prepareBeta({ ...f, plan: await planDevelopment(f) }),
      /sequence exhausted/,
    );
    assert.equal(
      f.calls.some((call) => call.commit || call.tree || call.createRef || call.createRelease),
      false,
    );
    assert.equal(f.references[`tags/${tag}`], oldHead);
  }
  const tag = "v0.26.2-beta.9";
  const retry = fixture({ refs: { [`tags/${tag}`]: generated } });
  assert.equal(await prepareBeta({ ...retry, plan: await planDevelopment(retry) }), tag);
  assert.equal(
    retry.calls.some((call) => call.commit),
    false,
  );
});

test("all publishing entry points reject out-of-policy Beta tags before mutation", async () => {
  for (const tag of ["v0.26.2-beta.10", "v0.26.2-beta.11", "v0.26.2-beta12", "v0.26.2-beta.2.1"]) {
    for (const operation of [prepareTaggedRelease, publishRelease]) {
      const f = publicationFixture(tag);
      await assert.rejects(operation({ ...f, tag }), /Release policy/);
      assert.deepEqual(f.calls, []);
    }
    const f = fixture({ refs: { [`tags/${tag}`]: generated } });
    await assert.rejects(
      ensureRelease({ ...f, tag, sha: generated, body: "Notes" }),
      /Release policy/,
    );
    await assert.rejects(prepareBeta({ ...f, plan: await planDevelopment(f) }), /Release policy/);
    assert.equal(
      f.calls.some((call) => call.commit || call.tree || call.createRef || call.createRelease),
      false,
    );
  }
});

test("historical multipart Beta tags reserve their original sequence", async () => {
  const tag = "v0.26.2-beta.2.1";
  const f = fixture({
    refs: { [`tags/${tag}`]: oldHead },
    messages: { [oldHead]: `Release-source: ${oldHead}` },
  });
  assert.equal(await prepareBeta({ ...f, plan: await planDevelopment(f) }), "v0.26.2-beta.3");
  assert.equal(f.references[`tags/${tag}`], oldHead);
});

test("an interrupted preparation resumes the reserved tag and a published source is skipped", async () => {
  const tag = "v0.26.2-beta.1";
  const f = fixture({ refs: { [`tags/${tag}`]: generated } });
  assert.equal(await prepareBeta({ ...f, plan: await planDevelopment(f) }), tag);
  assert.equal(
    f.calls.some((call) => call.commit),
    false,
  );
  const published = fixture({
    refs: { [`tags/${tag}`]: generated },
    releases: [{ tag_name: tag, target_commitish: generated, prerelease: true, draft: false }],
  });
  assert.equal(await prepareBeta({ ...published, plan: await planDevelopment(published) }), "");
  assert.equal(
    published.calls.some((call) => call.createRelease || call.commit),
    false,
  );
});

test("retrying a Beta rejects mismatched release sources", async () => {
  const tag = "v0.26.2-beta.1";
  const f = fixture({
    refs: { [`tags/${tag}`]: generated },
    releases: [{ tag_name: tag, target_commitish: oldHead, prerelease: true, draft: true }],
  });
  await assert.rejects(prepareBeta({ ...f, plan: await planDevelopment(f) }), /source\/channel/);
});

test("main migration skips publication and stable preparation requires reviewed promotion metadata", async () => {
  const f = fixture();
  assert.equal(await prepareStable(f), "");
  f.files[SOURCE_PATH] = JSON.stringify({ sourceSha: dev, baseSha: main, version: "0.26.1" });
  assert.equal(await prepareStable(f), "v0.26.1");
  f.files[SOURCE_PATH] = JSON.stringify({ sourceSha: dev, baseSha: baseline, version: "0.26.1" });
  await assert.rejects(prepareStable(f), /reviewed release promotion/);
});

test("stable releases tag the exact reviewed merge while retaining the original dev ancestry", async () => {
  const f = fixture({
    refs: { "heads/main": oldHead, "heads/dev": baseline },
    gitCommits: {
      [oldHead]: { tree: { sha: generated }, parents: [{ sha: main }, { sha: generated }] },
    },
  });
  f.files[SOURCE_PATH] = JSON.stringify({
    sourceSha: dev,
    baseSha: main,
    version: "0.26.1",
    history: "merge",
  });
  assert.equal(await prepareStable(f), "v0.26.1");
  assert.equal(f.calls.find((call) => call.createRelease).createRelease.target_commitish, oldHead);
  assert.equal(f.references["tags/v0.26.1"], oldHead);
});

test("stable merge validation refuses squash, rebase, unreviewed content and broken ancestry", async () => {
  for (const invalid of ["squash", "rebase", "base", "tree", "source"]) {
    const f = fixture({ refs: { "heads/main": oldHead } });
    f.files[SOURCE_PATH] = JSON.stringify({
      sourceSha: dev,
      baseSha: main,
      version: "0.26.1",
      history: "merge",
    });
    f.gitCommits[oldHead] = {
      tree: { sha: invalid === "tree" ? oldHead : generated },
      parents: (invalid === "squash"
        ? [main]
        : invalid === "rebase"
          ? [generated]
          : invalid === "base"
            ? [baseline, generated]
            : [main, generated]
      ).map((sha) => ({ sha })),
    };
    if (invalid === "source")
      f.gitCommits[generated] = { tree: { sha: generated }, parents: [{ sha: main }] };
    await assert.rejects(
      prepareStable(f),
      /merge commit|reviewed release tree|reviewed main and dev/,
    );
    assert.equal(
      f.calls.some((call) => call.createRef || call.createRelease),
      false,
    );
  }
});

function publicationFixture(tag, options = {}) {
  return fixture({
    refs: { [`tags/${tag}`]: generated, ...options.refs },
    releases: [
      {
        id: 1,
        tag_name: tag,
        target_commitish: generated,
        draft: true,
        prerelease: tag.includes("-"),
      },
      ...(options.releases || []),
    ],
    gitCommits: { [generated]: { parents: [{ sha: dev }], message: `Release-source: ${dev}` } },
  });
}

test("tagged Beta publication retains historical releases and uses its full version title", async () => {
  const tag = "v0.26.2-beta.2";
  const f = publicationFixture(tag, {
    releases: [
      { id: 2, name: "Nightly", tag_name: "v0.26.2-beta.11.1", draft: false, prerelease: true },
      { id: 3, name: "v0.26.1", tag_name: "v0.26.1", draft: false, prerelease: false },
    ],
  });
  await publishRelease({ ...f, tag });
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].publish.make_latest, "false");
  assert.equal(f.calls[0].publish.name, tag);
  assert.equal(f.calls[0].publish.draft, false);
});

test("a tagged snapshot can publish after dev advances, but divergent history is rejected", async () => {
  const tag = "v0.26.2-beta.1";
  const f = publicationFixture(tag, { refs: { "heads/dev": oldHead } });
  await publishRelease({ ...f, tag });
  assert.equal(f.calls.at(-1).publish.draft, false);
  const divergent = publicationFixture(tag, { refs: { "heads/dev": oldHead } });
  divergent.github.rest.repos.compareCommitsWithBasehead = async () => ({
    data: { status: "diverged" },
  });
  await assert.rejects(publishRelease({ ...divergent, tag }), /no longer in dev history/);
  assert.equal(
    divergent.calls.some((call) => call.publish),
    false,
  );
});

test("older Beta recovery preserves newer versions and cannot change latest stable", async () => {
  const tag = "v0.26.2-beta.2";
  const f = publicationFixture(tag, {
    releases: [
      {
        id: 2,
        name: "v0.26.2-beta.13.1",
        tag_name: "v0.26.2-beta.13.1",
        draft: false,
        prerelease: true,
      },
    ],
  });
  await publishRelease({ ...f, tag });
  assert.equal(f.calls[0].publish.make_latest, "false");
  assert.equal(
    f.calls.some((call) => call.deleteRelease),
    false,
  );
});

test("recovering an older stable release cannot move latest backwards", async () => {
  const tag = "v0.26.2";
  const f = publicationFixture(tag, {
    refs: { "heads/main": generated },
    releases: [{ id: 2, tag_name: "v0.27.0", draft: false, prerelease: false }],
  });
  await publishRelease({ ...f, tag });
  assert.equal(f.calls[0].publish.make_latest, "false");
  const latest = publicationFixture(tag, { refs: { "heads/main": generated } });
  await publishRelease({ ...latest, tag });
  assert.equal(latest.calls[0].publish.make_latest, "true");
  const advanced = publicationFixture(tag);
  await publishRelease({ ...advanced, tag });
  assert.equal(advanced.calls.at(-1).publish.make_latest, "false");
});

test("Nightly uses a source-derived alpha tag, numeric distance and its own update channel", async () => {
  const f = fixture();
  const plan = await planDevelopment(f);
  const tag = await prepareNightly({ ...f, plan });
  assert.equal(tag, `v0.26.2-alpha.1.d.1.g${dev.slice(0, 12)}`);
  const release = f.calls.find((call) => call.createRelease).createRelease;
  assert.equal(release.name, `${tag} (Nightly)`);
  assert.equal(release.prerelease, true);
  assert.equal(release.make_latest, "false");
  for (const path of VERSION_PATHS)
    assert.ok(f.contents.get(`${generated}:${path}`).includes(tag.slice(1)));
  assert.equal(f.references["tags/v0.26.2-beta.1"], undefined);
  assert.equal(await prepareNightly({ ...f, plan: {} }), "");
});

test("an unchanged Nightly source resumes the same draft or skips a published build", async () => {
  const tag = `v0.26.2-alpha.1.d.1.g${dev.slice(0, 12)}`;
  for (const draft of [true, false]) {
    const f = fixture({
      refs: { [`tags/${tag}`]: generated },
      releases: [{ tag_name: tag, target_commitish: generated, prerelease: true, draft }],
    });
    assert.equal(await prepareNightly({ ...f, plan: await planDevelopment(f) }), draft ? tag : "");
    assert.equal(
      f.calls.some((call) => call.commit || call.createRelease),
      false,
    );
  }
});

test("Nightly after Beta extends that milestone and skips a Beta's exact source", async () => {
  const beta = "v0.26.2-beta.3";
  const f = fixture({
    refs: { [`tags/${beta}`]: oldHead },
    messages: { [oldHead]: `Release-source: ${baseline}` },
  });
  const tag = await prepareNightly({ ...f, plan: await planDevelopment(f) });
  assert.equal(tag, `v0.26.2-beta.3.d.1.g${dev.slice(0, 12)}`);
  const unchanged = fixture({ refs: { [`tags/${beta}`]: oldHead } });
  assert.equal(await prepareNightly({ ...unchanged, plan: await planDevelopment(unchanged) }), "");
  assert.equal(
    unchanged.calls.some((call) => call.commit || call.createRelease),
    false,
  );
});

test("Nightly ignores out-of-policy Beta anchors and retains valid milestone history", async () => {
  const beta = "v0.26.2-beta.9";
  const f = fixture({
    refs: {
      [`tags/${beta}`]: oldHead,
      "tags/v0.26.2-beta.11": baseline,
      "tags/v0.26.2-beta12": main,
    },
    messages: { [oldHead]: `Release-source: ${baseline}` },
  });
  const tag = await prepareNightly({ ...f, plan: await planDevelopment(f) });
  assert.equal(tag, `v0.26.2-beta.9.d.1.g${dev.slice(0, 12)}`);
  assert.equal(f.references[`tags/${beta}`], oldHead);
  assert.equal(f.references["tags/v0.26.2-beta.10"], undefined);
});

test("Nightly publication is a versioned public prerelease and leaves Beta history intact", async () => {
  const tag = `v0.26.2-alpha.1.d.10.g${dev.slice(0, 12)}`;
  const f = publicationFixture(tag, {
    releases: [{ id: 2, tag_name: "v0.26.2-beta.1", prerelease: true, draft: false }],
  });
  await publishRelease({ ...f, tag });
  assert.equal(f.calls[0].publish.name, `${tag} (Nightly)`);
  assert.equal(f.calls[0].publish.prerelease, true);
  assert.equal(f.calls[0].publish.make_latest, "false");
  assert.equal(
    f.calls.some((call) => call.deleteRelease),
    false,
  );
});

test("direct tag publication validates all manifests, notes and branch ancestry", async () => {
  const tag = "v0.26.2-beta.1";
  const f = fixture({
    refs: { [`tags/${tag}`]: generated },
    gitCommits: {
      [generated]: { parents: [{ sha: dev }], message: `Release-source: ${dev}` },
    },
  });
  for (const [path, text] of Object.entries(versionContents(f.files, tag.slice(1))))
    f.contents.set(`${generated}:${path}`, text);
  f.contents.set(
    `${generated}:CHANGELOG.md`,
    `# Changelog\n\n## [Unreleased]\n\n## [${tag.slice(1)}]\n\n- Notes.\n`,
  );
  assert.equal(await prepareTaggedRelease({ ...f, tag }), tag);
  assert.equal(f.calls.find((call) => call.createRelease).createRelease.name, tag);
  f.contents.set(`${generated}:CITATION.cff`, "version: 0.0.0\n");
  await assert.rejects(prepareTaggedRelease({ ...f, tag }), /version manifests/);
});

test("annotated version tags are resolved to their immutable commit", async () => {
  const f = fixture();
  f.github.rest.git.getRef = async () => ({ data: { object: { type: "tag", sha: oldHead } } });
  f.github.rest.git.getTag = async () => ({ data: { object: { type: "commit", sha: dev } } });
  assert.equal(await resolveTag(f.github, context.repo, "v0.26.2-beta.1"), dev);
});

test("required checks stay bound to Actions and main protection has no bypass", () => {
  const ruleset = JSON.parse(
    readFileSync(new URL("../../../.github/main-ruleset.json", import.meta.url)),
  );
  assert.deepEqual(ruleset.bypass_actors, []);
  const checks = ruleset.rules.find((rule) => rule.type === "required_status_checks").parameters;
  assert.equal(checks.strict_required_status_checks_policy, true);
  assert.equal(checks.required_status_checks.length, 7);
  for (const check of checks.required_status_checks) assert.equal(check.integration_id, 15368);
  assert.equal(typeof branchSha, "function");
});
