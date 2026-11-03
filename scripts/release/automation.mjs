import { setTimeout as delay } from "node:timers/promises";
import {
  collectChanges,
  releasePrBody,
  releaseSection,
  renderRelease,
  replacePendingRelease,
  summarizeChanges,
} from "./release-notes.mjs";
import { bumpVersion, VERSION_PATHS, versionContents } from "./version.mjs";

export const RELEASE_BRANCH = "release/dev-to-main";
export const POLICY_CONTEXT = "PR policy";
export const SOURCE_PATH = ".github/release-source.json";
const SHA = /^[a-f0-9]{40}$/;
const TAG = /^v\d+\.\d+\.\d+(?:-beta\.\d+(?:\.\d+)?)?$/;

function compareReleaseTags(left, right) {
  const a = left.match(/\d+/g).map(BigInt);
  const b = right.match(/\d+/g).map(BigInt);
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    if (index === 3 && (a.length === 3 || b.length === 3))
      return a.length === b.length ? 0 : a.length === 3 ? 1 : -1;
    if (a[index] === undefined || b[index] === undefined)
      return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  }
  return 0;
}

export function validateTitle(title) {
  if (
    typeof title !== "string" ||
    !/^(feat|fix|perf|build|docs|test|ci|chore|refactor|style|revert)(\([\w./-]+\))?!?: \S[^\r\n]*$/.test(
      title,
    )
  )
    throw new Error("Use a Conventional Commit title, for example fix(terminal): restore paste");
}

export function isReleasePr(pr) {
  return pr.head.ref === RELEASE_BRANCH && pr.head.repo?.full_name === pr.base.repo.full_name;
}

export async function readText(github, repo, path, ref) {
  if (!SHA.test(ref)) throw new Error("Expected an immutable source SHA");
  const { data } = await github.rest.repos.getContent({ ...repo, path, ref });
  if (data.type !== "file" || data.encoding !== "base64") throw new Error(`Cannot read ${path}`);
  return Buffer.from(data.content, "base64").toString("utf8");
}

export async function branchSha(github, repo, branch) {
  const { data } = await github.rest.git.getRef({ ...repo, ref: `heads/${branch}` });
  if (data.object.type !== "commit" || !SHA.test(data.object.sha))
    throw new Error("Invalid branch source");
  return data.object.sha;
}

async function assertSources(github, repo, sources) {
  for (const [branch, sha] of Object.entries(sources)) {
    if ((await branchSha(github, repo, branch)) !== sha)
      throw new Error(`${branch} moved during preparation; rerun the workflow`);
  }
}

export function nextVersion(version, commits) {
  let part = "patch";
  for (const {
    commit: { message },
  } of commits) {
    if (/^\w+(?:\([^)]+\))?!:|^BREAKING[ -]CHANGE:/m.test(message)) {
      part = version.startsWith("0.") ? "minor" : "major";
      break;
    }
    if (/^feat(?:\([^)]+\))?:/.test(message)) part = "minor";
  }
  return bumpVersion(version, part);
}

export async function checkPullRequest({ github, context, number, expectedHead, wait = delay }) {
  const repo = context.repo;
  let { data: pr } = await github.rest.pulls.get({ ...repo, pull_number: number });
  if (!["main", "dev"].includes(pr.base.ref) || pr.state !== "open") return;
  let problem;
  let success = "Title and release source passed";
  try {
    validateTitle(pr.title);
    if (pr.base.ref === "main" && !isReleasePr(pr))
      throw new Error("Contributions target dev; main accepts the generated release PR");
    let commits;
    // PR metadata and commit lists can briefly disagree after a ref update.
    // Retry reads only; never approve a partial list or a different generated head.
    for (let attempt = 0; ; attempt++) {
      commits = await github.paginate(github.rest.pulls.listCommits, {
        ...repo,
        pull_number: number,
        per_page: 100,
      });
      if (
        (!expectedHead || pr.head.sha === expectedHead) &&
        commits.length === pr.commits &&
        commits.at(-1)?.sha === pr.head.sha &&
        new Set(commits.map((commit) => commit.sha)).size === commits.length &&
        commits.every((commit) => SHA.test(commit.sha))
      )
        break;
      if (attempt === 3 || pr.commits > 250)
        throw new Error(
          "Incomplete or changed PR commit history; refresh checks or split PRs over 250 commits",
        );
      await wait(1000 * 2 ** attempt);
      ({ data: pr } = await github.rest.pulls.get({ ...repo, pull_number: number }));
      if (!["main", "dev"].includes(pr.base.ref) || pr.state !== "open")
        throw new Error("PR target or state changed during checks; rerun the workflow");
      validateTitle(pr.title);
      if (pr.base.ref === "main" && !isReleasePr(pr))
        throw new Error("Contributions target dev; main accepts the generated release PR");
    }
    const invalid = commits.filter((commit) => {
      try {
        validateTitle(commit.commit.message.split(/\r?\n/, 1)[0]);
        return false;
      } catch {
        return true;
      }
    });
    if (invalid.length)
      throw new Error(
        `Use Conventional Commit subjects: ${invalid
          .slice(0, 3)
          .map((commit) => commit.sha.slice(0, 7))
          .join(", ")}${invalid.length > 3 ? ` (+${invalid.length - 3})` : ""}`,
      );
    success = `PR title and all ${commits.length} commit subjects passed`;
    if (isReleasePr(pr)) {
      if (commits.length !== 1) throw new Error("The generated release PR must contain one commit");
      const marker = JSON.parse(await readText(github, repo, SOURCE_PATH, pr.head.sha));
      // PR base.sha is a snapshot; resolve both actual refs on every check.
      await assertSources(github, repo, { main: marker.baseSha, dev: marker.sourceSha });
    }
  } catch (error) {
    problem = error.message;
  }
  await github.rest.repos.createCommitStatus({
    ...repo,
    sha: pr.head.sha,
    context: POLICY_CONTEXT,
    state: problem ? "failure" : "success",
    description: (problem || success).slice(0, 140),
    target_url: `${context.serverUrl}/${repo.owner}/${repo.repo}/actions/runs/${context.runId}`,
  });
  if (problem) throw new Error(problem);
}

export async function refreshReleasePolicy({ github, context }) {
  const prs = await github.paginate(github.rest.pulls.list, {
    ...context.repo,
    state: "open",
    base: "main",
    head: `${context.repo.owner}:${RELEASE_BRANCH}`,
  });
  for (const pr of prs) await checkPullRequest({ github, context, number: pr.number });
}

async function commitTree({ github, repo, source, parent, contents, message }) {
  const { data: original } = await github.rest.git.getCommit({ ...repo, commit_sha: source });
  const { data: tree } = await github.rest.git.createTree({
    ...repo,
    base_tree: original.tree.sha,
    tree: Object.entries(contents).map(([path, content]) => ({
      path,
      mode: "100644",
      type: "blob",
      content,
    })),
  });
  const { data: commit } = await github.rest.git.createCommit({
    ...repo,
    tree: tree.sha,
    parents: [parent],
    message,
  });
  return commit.sha;
}

async function assertMainHasNoUnpromotedChanges(github, repo, main, dev, marker) {
  if (!marker.baseSha) return; // Initial migration, before the first dev promotion.
  const trees = await Promise.all(
    [main, marker.sourceSha, dev].map(async (sha) => {
      const { data } = await github.rest.git.getTree({ ...repo, tree_sha: sha, recursive: "true" });
      if (data.truncated) throw new Error("Cannot safely compare truncated source trees");
      return new Map(
        data.tree
          .filter((entry) => entry.type !== "tree")
          .map((entry) => [entry.path, `${entry.mode}:${entry.sha}`]),
      );
    }),
  );
  const generated = new Set([...VERSION_PATHS, "CHANGELOG.md", SOURCE_PATH]);
  for (const path of new Set(trees.flatMap((tree) => [...tree.keys()]))) {
    if (
      !generated.has(path) &&
      trees[0].get(path) !== trees[1].get(path) &&
      trees[0].get(path) !== trees[2].get(path)
    )
      throw new Error(
        `Main has changes outside release metadata (${path}); merge main into dev before promoting`,
      );
  }
}

export async function planDevelopment({
  github,
  context,
  date = new Date().toISOString().slice(0, 10),
}) {
  const repo = context.repo;
  const [main, dev] = await Promise.all(
    ["main", "dev"].map((branch) => branchSha(github, repo, branch)),
  );
  let markerText;
  try {
    markerText = await readText(github, repo, SOURCE_PATH, main);
  } catch (error) {
    if (error.status !== 404) throw error;
    return { main, dev }; // Wait for the reviewed migration PR to reach protected main.
  }
  const [pkg, history, developmentNotes, ...files] = await Promise.all([
    readText(github, repo, "package.json", main),
    readText(github, repo, "CHANGELOG.md", main),
    readText(github, repo, "CHANGELOG.md", dev),
    ...VERSION_PATHS.map((path) => readText(github, repo, path, dev)),
  ]);
  const marker = JSON.parse(markerText);
  if (!SHA.test(marker.sourceSha)) throw new Error("Invalid last promoted dev source");
  const commits = await collectChanges({ github, repo, base: marker.sourceSha, head: dev });
  if (!summarizeChanges(commits).length) return { main, dev };
  await assertMainHasNoUnpromotedChanges(github, repo, main, dev, marker);
  const previousVersion = JSON.parse(pkg).version;
  const version = nextVersion(previousVersion, commits);
  const release = renderRelease({
    version,
    previousVersion,
    date,
    repository: `${repo.owner}/${repo.repo}`,
    commits,
    curated: releaseSection(developmentNotes, "Unreleased").notes,
  });
  return {
    main,
    dev,
    version,
    previousVersion,
    release,
    history,
    files: Object.fromEntries(VERSION_PATHS.map((path, index) => [path, files[index]])),
  };
}

export async function maintainReleasePr({ github, context, plan }) {
  if (!plan.version) return;
  const repo = context.repo;
  const prs = await github.paginate(github.rest.pulls.list, {
    ...repo,
    state: "open",
    base: "main",
    head: `${repo.owner}:${RELEASE_BRANCH}`,
  });
  if (prs.length > 1) throw new Error("Multiple release pull requests found");
  let previous;
  try {
    previous = await branchSha(github, repo, RELEASE_BRANCH);
  } catch (error) {
    if (error.status !== 404) throw error;
  }
  if (previous && prs.length) {
    const marker = JSON.parse(await readText(github, repo, SOURCE_PATH, previous));
    if (marker.sourceSha === plan.dev && marker.baseSha === plan.main) {
      await checkReleasePullRequest({ github, context, number: prs[0].number, sha: previous });
      return;
    }
  }
  const contents = {
    ...versionContents(plan.files, plan.version),
    "CHANGELOG.md": replacePendingRelease(plan.history, plan.release),
    [SOURCE_PATH]: `${JSON.stringify({ sourceSha: plan.dev, baseSha: plan.main, version: plan.version }, null, 2)}\n`,
  };
  const sha = await commitTree({
    github,
    repo,
    source: plan.dev,
    parent: plan.main,
    contents,
    message: `chore(main): release ${plan.version}\n\nRelease-source: ${plan.dev}`,
  });
  await assertSources(github, repo, { main: plan.main, dev: plan.dev });
  if (previous) {
    await assertSources(github, repo, { [RELEASE_BRANCH]: previous });
    // This generated branch is serialized by the development workflow; never contribute here.
    await github.rest.git.updateRef({ ...repo, ref: `heads/${RELEASE_BRANCH}`, sha, force: true });
  } else await github.rest.git.createRef({ ...repo, ref: `refs/heads/${RELEASE_BRANCH}`, sha });
  const body = releasePrBody(plan.version, plan.release.count, `${repo.owner}/${repo.repo}`, sha);
  const title = `chore(main): release ${plan.version}`;
  let number = prs[0]?.number;
  if (number) await github.rest.pulls.update({ ...repo, pull_number: number, title, body });
  else {
    const { data: pr } = await github.rest.pulls.create({
      ...repo,
      base: "main",
      head: RELEASE_BRANCH,
      title,
      body,
    });
    number = pr.number;
  }
  await checkReleasePullRequest({ github, context, number, sha });
}

async function checkReleasePullRequest({ github, context, number, sha }) {
  await checkPullRequest({ github, context, number, expectedHead: sha });
  // GITHUB_TOKEN writes do not trigger pull_request; dispatch checks explicitly.
  await github.rest.actions.createWorkflowDispatch({
    ...context.repo,
    workflow_id: "ci.yml",
    ref: RELEASE_BRANCH,
  });
}

export async function ensureRelease({ github, context, tag, sha, body, nightly = false }) {
  if (!TAG.test(tag) || !SHA.test(sha) || tag.includes("-beta.") !== nightly || !body?.trim())
    throw new Error("Invalid release source, channel or notes");
  const repo = context.repo;
  // Tag must exist before the draft, avoiding GitHub's untagged draft conversion.
  try {
    const { data } = await github.rest.git.getRef({ ...repo, ref: `tags/${tag}` });
    if (data.object.type !== "commit" || data.object.sha !== sha)
      throw new Error("Existing tag points elsewhere");
  } catch (error) {
    if (error.status !== 404) throw error;
    await github.rest.git.createRef({ ...repo, ref: `refs/tags/${tag}`, sha });
  }
  const releases = await github.paginate(github.rest.repos.listReleases, {
    ...repo,
    per_page: 100,
  });
  const matching = releases.filter((release) => release.tag_name === tag);
  if (matching.length > 1) throw new Error("Duplicate release tag");
  if (matching.length) {
    const release = matching[0];
    if (release.target_commitish !== sha || release.prerelease !== nightly)
      throw new Error("Release source/channel mismatch");
    return release.draft ? tag : "";
  }
  await github.rest.repos.createRelease({
    ...repo,
    tag_name: tag,
    target_commitish: sha,
    name: nightly ? "Nightly" : `Tunnelde ${tag.slice(1)}`,
    body,
    draft: true,
    prerelease: nightly,
    make_latest: "false",
  });
  return tag;
}

export async function prepareNightly({ github, context, plan }) {
  if (!plan.version) return "";
  const repo = context.repo;
  await assertSources(github, repo, { dev: plan.dev });
  // Releases are retired, but immutable tags reserve every allocated sequence.
  const { data: refs } = await github.rest.git.listMatchingRefs({
    ...repo,
    ref: `tags/v${plan.version}-beta.`,
  });
  const tags = refs
    .map((ref) => ({ ...ref, tag: ref.ref.replace(/^refs\/tags\//, "") }))
    .filter(({ tag }) => TAG.test(tag) && tag.startsWith(`v${plan.version}-beta.`))
    .sort((a, b) => compareReleaseTags(b.tag, a.tag));
  const latest = tags[0];
  const body = `Development build from ${plan.dev}.\n\n${plan.release.notes}`;
  if (latest) {
    if (latest.object.type !== "commit" || !SHA.test(latest.object.sha))
      throw new Error("Invalid existing Nightly tag");
    const { data: commit } = await github.rest.git.getCommit({
      ...repo,
      commit_sha: latest.object.sha,
    });
    if (/^Release-source: ([a-f0-9]{40})$/m.exec(commit.message)?.[1] === plan.dev) {
      await assertSources(github, repo, { dev: plan.dev });
      return ensureRelease({
        github,
        context,
        tag: latest.tag,
        sha: latest.object.sha,
        nightly: true,
        body,
      });
    }
  }
  const sequence = latest ? BigInt(/-beta\.(\d+)/.exec(latest.tag)[1]) + 1n : 1n;
  const version = `${plan.version}-beta.${sequence}`;
  const release = {
    ...plan.release,
    heading: plan.release.heading.replace(`[${plan.version}]`, `[${version}]`),
  };
  const sha = await commitTree({
    github,
    repo: context.repo,
    source: plan.dev,
    parent: plan.dev,
    contents: {
      ...versionContents(plan.files, version),
      "CHANGELOG.md": replacePendingRelease(plan.history, release),
    },
    message: `chore: Nightly ${version}\n\nRelease-source: ${plan.dev}`,
  });
  await assertSources(github, context.repo, { dev: plan.dev });
  return ensureRelease({
    github,
    context,
    tag: `v${version}`,
    sha,
    nightly: true,
    body,
  });
}

export async function prepareStable({ github, context }) {
  const repo = context.repo;
  const sha = await branchSha(github, repo, "main");
  const marker = JSON.parse(await readText(github, repo, SOURCE_PATH, sha));
  if (!marker.baseSha) return ""; // Migration does not invent another stable release.
  const { data: commit } = await github.rest.git.getCommit({ ...repo, commit_sha: sha });
  if (commit.parents.length !== 1 || commit.parents[0].sha !== marker.baseSha)
    throw new Error("Main is not the reviewed release promotion");
  const version = JSON.parse(await readText(github, repo, "package.json", sha)).version;
  if (version !== marker.version || !SHA.test(marker.sourceSha))
    throw new Error("Release metadata mismatch");
  const body = releaseSection(await readText(github, repo, "CHANGELOG.md", sha), version).notes;
  await assertSources(github, repo, { main: sha });
  return ensureRelease({ github, context, tag: `v${version}`, sha, body });
}

export async function publishRelease({ github, context, tag }) {
  const repo = context.repo;
  const nightly = tag.includes("-beta.");
  const releases = await github.paginate(github.rest.repos.listReleases, {
    ...repo,
    per_page: 100,
  });
  const release = releases.find((item) => item.tag_name === tag);
  if (!release?.draft || release.prerelease !== nightly)
    throw new Error("Expected matching draft channel");
  const { data: ref } = await github.rest.git.getRef({ ...repo, ref: `tags/${tag}` });
  if (ref.object.sha !== release.target_commitish) throw new Error("Release tag moved");
  if (nightly) {
    if (!TAG.test(tag)) throw new Error("Invalid beta tag");
    const newer = releases.some((item) => {
      return (
        item.name === "Nightly" &&
        item.prerelease &&
        !item.draft &&
        TAG.test(item.tag_name) &&
        compareReleaseTags(item.tag_name, tag) > 0
      );
    });
    if (newer) throw new Error("A newer Nightly is already published");
    const { data: commit } = await github.rest.git.getCommit({
      ...repo,
      commit_sha: ref.object.sha,
    });
    const source = /^Release-source: ([a-f0-9]{40})$/m.exec(commit.message)?.[1];
    await assertSources(github, repo, { dev: source });
  } else await assertSources(github, repo, { main: ref.object.sha });
  await github.rest.repos.updateRelease({
    ...repo,
    release_id: release.id,
    draft: false,
    prerelease: nightly,
    make_latest: nightly ? "false" : "true",
    name: nightly ? "Nightly" : `Tunnelde ${tag.slice(1)}`,
  });
  if (nightly) {
    // Keep the previous working Nightly until its verified replacement is public.
    for (const old of releases) {
      if (
        old.id !== release.id &&
        old.name === "Nightly" &&
        old.prerelease &&
        TAG.test(old.tag_name) &&
        old.tag_name.includes("-beta.")
      )
        await github.rest.repos.deleteRelease({ ...repo, release_id: old.id });
    }
  }
}
