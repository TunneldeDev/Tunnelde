import { SHA, readText, branchSha, assertSources, commitTree } from "../github/sources.mjs";
import {
  collectChanges,
  releasePrBody,
  releaseSection,
  renderRelease,
  replacePendingRelease,
  summarizeChanges,
} from "../metadata/notes.mjs";
import { bumpVersion } from "../version.mjs";
import { VERSION_PATHS, versionContents } from "../metadata/version-files.mjs";
import { RELEASE_BRANCH, SOURCE_PATH, assertMainHasNoUnpromotedChanges } from "./validation.mjs";
import { checkPullRequest } from "./policy.mjs";

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
  // dev keeps its source history after promotion, including old Unreleased notes.
  // Only newly edited summaries belong to this release cycle.
  const promotedNotes = await readText(github, repo, "CHANGELOG.md", marker.sourceSha);
  const currentSummary = releaseSection(developmentNotes, "Unreleased").notes;
  const previousSummary = releaseSection(promotedNotes, "Unreleased").notes;
  const curated =
    currentSummary.replace(/\r\n/g, "\n") === previousSummary.replace(/\r\n/g, "\n")
      ? ""
      : currentSummary;
  const release = renderRelease({
    version,
    previousVersion,
    date,
    repository: `${repo.owner}/${repo.repo}`,
    commits,
    curated,
  });
  return {
    main,
    dev,
    version,
    previousVersion,
    distance: commits.length,
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
  let legacyDraft;
  try {
    previous = await branchSha(github, repo, RELEASE_BRANCH);
  } catch (error) {
    if (error.status !== 404) throw error;
  }
  if (previous && prs.length) {
    const marker = JSON.parse(await readText(github, repo, SOURCE_PATH, previous));
    if (marker.history !== "merge" && prs[0].draft) legacyDraft = prs[0].node_id;
    if (
      marker.history === "merge" &&
      marker.sourceSha === plan.dev &&
      marker.baseSha === plan.main
    ) {
      return checkReleasePullRequest({ github, context, number: prs[0].number, sha: previous });
    }
  }
  const contents = {
    ...versionContents(plan.files, plan.version),
    "CHANGELOG.md": replacePendingRelease(plan.history, plan.release),
    [SOURCE_PATH]: `${JSON.stringify({ sourceSha: plan.dev, baseSha: plan.main, version: plan.version, history: "merge" }, null, 2)}\n`,
  };
  const sha = await commitTree({
    github,
    repo,
    source: plan.dev,
    parent: plan.main,
    mergeParent: plan.dev,
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
  const checked = await checkReleasePullRequest({ github, context, number, sha });
  if (legacyDraft)
    await github.graphql(
      "mutation($id: ID!) { markPullRequestReadyForReview(input: {pullRequestId: $id}) { pullRequest { id } } }",
      { id: legacyDraft },
    );
  return checked;
}

export async function checkReleasePullRequest({ github, context, number, sha }) {
  await checkPullRequest({ github, context, number, expectedHead: sha });
  // Bot-created PR runs may require a maintainer's approval. A workflow_dispatch
  // run is a separate suite and does not release that pending PR run. Do not
  // spend another full CI matrix on each dev update or bypass review here.
  return { number, sha };
}
