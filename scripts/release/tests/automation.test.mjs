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
  prepareNightly,
  prepareStable,
  publishRelease,
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
  pr,
  moved = false,
} = {}) {
  const calls = [];
  const contents = new Map();
  const references = { "heads/main": main, "heads/dev": dev, ...refs };
  const files = { ...versionFiles, "CHANGELOG.md": history, [SOURCE_PATH]: JSON.stringify(marker) };
  const pull = pr || {
    number: 15,
    title: "fix: restore paste",
    state: "open",
    head: { ref: "fix/paste", sha: oldHead, repo },
    base: { ref: "dev", sha: baseline, repo },
  };
  let comparisons = 0;
  const github = {
    paginate: (method, args) => method(args),
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
          data: {
            tree: { sha: commit_sha },
            parents: [{ sha: main }],
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
  return { github, context, calls, files, contents, references };
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

test("stable and beta transforms update all eight versions, are idempotent, and reject missing metadata", () => {
  for (const version of ["0.26.2", "0.26.2-beta.1", "0.26.2-beta.12.1"]) {
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

test("Nightly reruns reuse their immutable tag rather than creating another commit", async () => {
  const tag = "v0.26.2-beta.1";
  const f = fixture({
    refs: { [`tags/${tag}`]: generated },
    releases: [{ tag_name: tag, target_commitish: generated, prerelease: true, draft: true }],
  });
  const plan = await planDevelopment(f);
  assert.equal(await prepareNightly({ ...f, plan }), tag);
  assert.equal(
    f.calls.some((call) => call.commit),
    false,
  );
});

test("promotion tree is dev content with main history and a single main parent, without modifying dev or main", async () => {
  const f = fixture();
  const plan = await planDevelopment(f);
  await maintainReleasePr({ ...f, plan });
  const tree = f.calls.find((call) => call.tree).tree;
  assert.equal(tree.base_tree, dev);
  const notes = tree.tree.find((entry) => entry.path === "CHANGELOG.md").content;
  assert.ok(notes.includes("## [0.26.2]"));
  assert.ok(notes.endsWith("## [0.26.1] - 2026-11-03\n\n- Historical notes.\n"));
  assert.deepEqual(f.calls.find((call) => call.commit).commit.parents, [main]);
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
  f.contents.set(`${generated}:${SOURCE_PATH}`, JSON.stringify({ baseSha: main, sourceSha: dev }));
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
    ensureRelease({ ...f, tag: "v0.26.2", sha: main, body: "Notes", nightly: true }),
    /channel/,
  );
});

test("Nightly uses beta manifests, its own immutable tag and does not become latest stable", async () => {
  const f = fixture();
  const plan = await planDevelopment(f);
  const tag = await prepareNightly({ ...f, plan });
  assert.equal(tag, "v0.26.2-beta.1");
  const release = f.calls.find((call) => call.createRelease).createRelease;
  assert.equal(release.prerelease, true);
  assert.equal(release.make_latest, "false");
  assert.equal(release.name, "Nightly");
  assert.deepEqual(f.calls.find((call) => call.commit).commit.parents, [dev]);
  assert.ok(f.contents.get(`${generated}:CITATION.cff`).includes("0.26.2-beta.1"));
});

test("beta sequences advance numerically using tags even after releases are retired", async () => {
  const f = fixture({
    refs: {
      "tags/v0.26.2-beta.9": baseline,
      "tags/v0.26.2-beta.10": oldHead,
      "tags/v0.26.2-beta.99-invalid": main,
    },
    messages: {
      [baseline]: `Release-source: ${baseline}`,
      [oldHead]: `Release-source: ${oldHead}`,
    },
  });
  assert.equal(await prepareNightly({ ...f, plan: await planDevelopment(f) }), "v0.26.2-beta.11");
  assert.equal(f.references["tags/v0.26.2-beta.10"], oldHead);
});

test("each target stable version starts its own beta sequence at one", async () => {
  for (const version of ["0.26.3", "0.27.0", "1.0.0"]) {
    const f = fixture({ refs: { "tags/v0.26.2-beta.99.2": oldHead } });
    const plan = { ...(await planDevelopment(f)), version };
    assert.equal(await prepareNightly({ ...f, plan }), `v${version}-beta.1`);
  }
});

test("legacy beta tags reserve their original sequence and remain recoverable", async () => {
  const tag = "v0.26.2-beta.2.1";
  const f = fixture({
    refs: { [`tags/${tag}`]: oldHead },
    messages: { [oldHead]: `Release-source: ${oldHead}` },
  });
  assert.equal(await prepareNightly({ ...f, plan: await planDevelopment(f) }), "v0.26.2-beta.3");
  const retry = fixture({ refs: { [`tags/${tag}`]: generated } });
  assert.equal(await prepareNightly({ ...retry, plan: await planDevelopment(retry) }), tag);
  assert.equal(
    retry.calls.some((call) => call.commit),
    false,
  );
});

test("an interrupted preparation resumes the reserved tag and a published source is skipped", async () => {
  const tag = "v0.26.2-beta.1";
  const f = fixture({ refs: { [`tags/${tag}`]: generated } });
  assert.equal(await prepareNightly({ ...f, plan: await planDevelopment(f) }), tag);
  assert.equal(
    f.calls.some((call) => call.commit),
    false,
  );
  const published = fixture({
    refs: { [`tags/${tag}`]: generated },
    releases: [{ tag_name: tag, target_commitish: generated, prerelease: true, draft: false }],
  });
  assert.equal(await prepareNightly({ ...published, plan: await planDevelopment(published) }), "");
  assert.equal(
    published.calls.some((call) => call.createRelease || call.commit),
    false,
  );
});

test("retrying a Nightly rejects mismatched release sources", async () => {
  const tag = "v0.26.2-beta.1";
  const f = fixture({
    refs: { [`tags/${tag}`]: generated },
    releases: [{ tag_name: tag, target_commitish: oldHead, prerelease: true, draft: true }],
  });
  await assert.rejects(prepareNightly({ ...f, plan: await planDevelopment(f) }), /source\/channel/);
});

test("main migration skips publication and stable preparation requires reviewed promotion metadata", async () => {
  const f = fixture();
  assert.equal(await prepareStable(f), "");
  f.files[SOURCE_PATH] = JSON.stringify({ sourceSha: dev, baseSha: main, version: "0.26.1" });
  assert.equal(await prepareStable(f), "v0.26.1");
  f.files[SOURCE_PATH] = JSON.stringify({ sourceSha: dev, baseSha: baseline, version: "0.26.1" });
  await assert.rejects(prepareStable(f), /reviewed release promotion/);
});

test("Nightly publication happens before retiring the previous Nightly and preserves stable releases", async () => {
  const tag = "v0.26.2-beta.12.1";
  const f = fixture({
    refs: { [`tags/${tag}`]: generated },
    releases: [
      { id: 1, tag_name: tag, target_commitish: generated, draft: true, prerelease: true },
      { id: 2, name: "Nightly", tag_name: "v0.26.2-beta.11.1", draft: false, prerelease: true },
      { id: 3, name: "Tunnelde 0.26.1", tag_name: "v0.26.1", draft: false, prerelease: false },
    ],
  });
  await publishRelease({ ...f, tag });
  assert.deepEqual(
    f.calls.map((call) => Object.keys(call)[0]),
    ["publish", "deleteRelease"],
  );
  assert.equal(f.calls[0].publish.make_latest, "false");
  assert.equal(f.calls[1].deleteRelease.release_id, 2);
});

test("an obsolete Nightly cannot replace the current build; stable publication selects latest", async () => {
  const tag = "v0.26.2-beta.12.1";
  const f = fixture({
    refs: { [`tags/${tag}`]: generated, "heads/dev": baseline },
    releases: [
      { id: 1, tag_name: tag, target_commitish: generated, draft: true, prerelease: true },
    ],
  });
  await assert.rejects(publishRelease({ ...f, tag }), /dev moved/);
  assert.deepEqual(f.calls, []);
  const stable = fixture({
    refs: { "tags/v0.26.2": main },
    releases: [
      { id: 4, tag_name: "v0.26.2", target_commitish: main, draft: true, prerelease: false },
    ],
  });
  await publishRelease({ ...stable, tag: "v0.26.2" });
  assert.equal(stable.calls[0].publish.make_latest, "true");
});

test("recovery cannot replace a newer Nightly even when dev has not moved", async () => {
  const tag = "v0.26.2-beta.12.1";
  const f = fixture({
    refs: { [`tags/${tag}`]: generated },
    releases: [
      { id: 1, tag_name: tag, target_commitish: generated, draft: true, prerelease: true },
      { id: 2, name: "Nightly", tag_name: "v0.26.2-beta.13.1", draft: false, prerelease: true },
    ],
  });
  await assert.rejects(publishRelease({ ...f, tag }), /newer Nightly/);
  assert.deepEqual(f.calls, []);
});

test("Nightly publication compares target versions before reset beta sequences", async () => {
  const tag = "v0.27.0-beta.1";
  const f = fixture({
    refs: { [`tags/${tag}`]: generated },
    releases: [
      { id: 1, tag_name: tag, target_commitish: generated, draft: true, prerelease: true },
      { id: 2, name: "Nightly", tag_name: "v0.26.2-beta.99.1", draft: false, prerelease: true },
    ],
  });
  await publishRelease({ ...f, tag });
  assert.equal(f.calls[0].publish.release_id, 1);
  assert.equal(f.calls[1].deleteRelease.release_id, 2);
  const stale = fixture({
    refs: { "tags/v0.26.2-beta.99.1": oldHead },
    releases: [
      {
        id: 1,
        tag_name: "v0.26.2-beta.99.1",
        target_commitish: oldHead,
        draft: true,
        prerelease: true,
      },
      { id: 2, name: "Nightly", tag_name: tag, draft: false, prerelease: true },
    ],
  });
  await assert.rejects(publishRelease({ ...stale, tag: "v0.26.2-beta.99.1" }), /newer Nightly/);
  assert.deepEqual(stale.calls, []);
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
