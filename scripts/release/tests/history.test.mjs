import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import {
  maintainReleasePr,
  planDevelopment,
  prepareStable,
  RELEASE_BRANCH,
  SOURCE_PATH,
} from "../automation.mjs";
import { VERSION_PATHS, versionContents } from "../version.mjs";

test("two real Git promotions preserve original dev SHAs and exclude already released work", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "tunnelde-release-history-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const git = (args, options = {}) =>
    execFileSync(
      "git",
      [
        "-c",
        "commit.gpgsign=false",
        "-c",
        `core.hooksPath=${join(directory, "no-hooks")}`,
        "-c",
        "user.name=Release Test",
        "-c",
        "user.email=release-test@example.invalid",
        ...args,
      ],
      { cwd: directory, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], ...options },
    ).trimEnd();
  const write = (path, text) => {
    mkdirSync(dirname(join(directory, path)), { recursive: true });
    writeFileSync(join(directory, path), text);
  };
  const commit = (path, text, message) => {
    write(path, text);
    git(["add", path]);
    git(["commit", "-qm", message]);
    return git(["rev-parse", "HEAD"]);
  };
  git(["init", "-q", "--initial-branch=main"]);
  const files = versionContents(
    Object.fromEntries(
      VERSION_PATHS.map((path) => [
        path,
        readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8"),
      ]),
    ),
    "0.26.1",
  );
  for (const [path, contents] of Object.entries(files)) write(path, contents);
  write("CHANGELOG.md", "# Changelog\n\n## [Unreleased]\n\n## [0.26.1]\n\n- History.\n");
  git(["add", "."]);
  git(["commit", "-qm", "chore: initial source"]);
  const baseline = git(["rev-parse", "HEAD"]);
  commit(
    SOURCE_PATH,
    JSON.stringify({ sourceSha: baseline, baseSha: null, version: "0.26.1" }),
    "ci: initialize release metadata",
  );
  git(["switch", "-qc", "dev"]);
  const originals = [
    commit("one.txt", "one\n", "fix: first change"),
    commit("two.txt", "two\n", "fix: second change"),
  ];
  const context = {
    repo: { owner: "TunneldeDev", repo: "Tunnelde" },
    serverUrl: "https://github.com",
    runId: 123,
  };
  const repo = { full_name: "TunneldeDev/Tunnelde" };
  const readCommit = (sha) => {
    const [tree, parents, ...message] = git(["show", "-s", "--format=%T%n%P%n%B", sha]).split("\n");
    return {
      sha,
      tree: { sha: tree },
      parents: parents
        .split(" ")
        .filter(Boolean)
        .map((sha) => ({ sha })),
      commit: { message: message.join("\n") },
    };
  };
  const ref = (name) => git(["rev-parse", "--verify", name]);
  let pull;
  const releases = [];
  const github = {
    paginate: (method, args) => method(args),
    rest: {
      git: {
        getRef: async ({ ref: name }) => {
          try {
            return { data: { object: { type: "commit", sha: ref(`refs/${name}`) } } };
          } catch {
            throw Object.assign(new Error("Not found"), { status: 404 });
          }
        },
        getCommit: async ({ commit_sha }) => ({ data: readCommit(commit_sha) }),
        getTree: async ({ tree_sha }) => ({
          data: {
            truncated: false,
            tree: git(["ls-tree", "-rz", "--full-tree", tree_sha])
              .split("\0")
              .filter(Boolean)
              .map((entry) => {
                const [metadata, path] = entry.split("\t");
                const [mode, type, sha] = metadata.split(" ");
                return { mode, type, sha, path };
              }),
          },
        }),
        createTree: async ({ base_tree, tree }) => {
          const options = {
            env: { ...process.env, GIT_INDEX_FILE: join(directory, "release-index") },
          };
          git(["read-tree", base_tree], options);
          for (const { path, content, mode } of tree) {
            const sha = git(["hash-object", "-w", "--stdin"], { input: content });
            git(["update-index", "--add", "--cacheinfo", mode, sha, path], options);
          }
          return { data: { sha: git(["write-tree"], options) } };
        },
        createCommit: async ({ tree, parents, message }) => ({
          data: {
            sha: git([
              "commit-tree",
              tree,
              ...parents.flatMap((parent) => ["-p", parent]),
              "-m",
              message,
            ]),
          },
        }),
        createRef: async ({ ref: name, sha }) => git(["update-ref", name, sha]),
        updateRef: async ({ ref: name, sha }) => git(["update-ref", `refs/${name}`, sha]),
      },
      repos: {
        getContent: async ({ ref: sha, path }) => ({
          data: {
            type: "file",
            encoding: "base64",
            content: Buffer.from(git(["show", `${sha}:${path}`])).toString("base64"),
          },
        }),
        compareCommitsWithBasehead: async ({ basehead }) => {
          const [base, head] = basehead.split("...");
          git(["merge-base", "--is-ancestor", base, head]);
          const commits = git(["rev-list", "--reverse", `${base}..${head}`])
            .split("\n")
            .filter(Boolean)
            .map(readCommit);
          return {
            data: {
              status: commits.length ? "ahead" : "identical",
              total_commits: commits.length,
              commits,
            },
          };
        },
        listPullRequestsAssociatedWithCommit: async () => [],
        createCommitStatus: async ({ state, description }) =>
          assert.equal(state, "success", description),
        listReleases: async () => releases,
        createRelease: async (release) => releases.push({ ...release, id: releases.length + 1 }),
      },
      pulls: {
        list: async () => (pull ? [pull] : []),
        listCommits: async () =>
          git(["rev-list", "--reverse", `main..${RELEASE_BRANCH}`])
            .split("\n")
            .filter(Boolean)
            .map(readCommit),
        get: async () => ({
          data: {
            ...pull,
            commits: Number(git(["rev-list", "--count", `main..${RELEASE_BRANCH}`])),
            head: { ref: RELEASE_BRANCH, repo, sha: ref(RELEASE_BRANCH) },
          },
        }),
        create: async ({ title }) => {
          pull = { number: 16, state: "open", title, base: { ref: "main", repo } };
          return { data: pull };
        },
        update: async ({ title }) => {
          pull.title = title;
        },
      },
      actions: { createWorkflowDispatch: async () => {} },
    },
  };
  for (const version of ["0.26.2", "0.26.3"]) {
    const plan = await planDevelopment({ github, context });
    assert.equal(plan.version, version);
    if (version === "0.26.3") {
      assert.equal(plan.release.count, 1);
      assert.match(plan.release.notes, /third change/);
      assert.doesNotMatch(plan.release.notes, /first change|second change/);
    }
    await maintainReleasePr({ github, context, plan });
    assert.equal(ref("main"), plan.main);
    assert.equal(ref("dev"), plan.dev);
    assert.deepEqual(
      readCommit(ref(RELEASE_BRANCH)).parents.map(({ sha }) => sha),
      [plan.main, plan.dev],
    );
    git(["merge-base", "--is-ancestor", plan.main, RELEASE_BRANCH]);
    git(["switch", "-q", "main"]);
    git(["merge", "--no-ff", "-qm", `chore(main): release ${version}`, RELEASE_BRANCH]);
    for (const sha of originals) git(["merge-base", "--is-ancestor", sha, "main"]);
    assert.equal(await prepareStable({ github, context }), `v${version}`);
    assert.equal(ref(`v${version}`), ref("main"));
    assert.equal((await planDevelopment({ github, context })).version, undefined);
    pull = undefined;
    if (version === "0.26.2") {
      git(["switch", "-q", "dev"]);
      originals.push(commit("three.txt", "three\n", "fix: third change"));
    }
  }
});
