import {
  collectChanges,
  releasePrBody,
  releaseSection,
  renderRelease,
  replacePendingRelease,
} from "./release-notes.mjs";

const RELEASE_BRANCH = "release-please--branches--main";
export const POLICY_CONTEXT = "PR policy";

export function validateTitle(title) {
  if (
    typeof title !== "string" ||
    !/^(feat|fix|perf|build|docs|test|ci|chore|refactor|style|revert)(\([\w./-]+\))?!?: \S[^\r\n]*$/.test(
      title,
    )
  ) {
    throw new Error("Use a Conventional Commit title, for example fix(terminal): restore paste");
  }
}

export function isReleasePr(pr) {
  return pr.head.ref === RELEASE_BRANCH && pr.head.repo?.full_name === pr.base.repo.full_name;
}

export function assertNoDrafts(releases, allowedTag) {
  const blocked = releases.filter((release) => release.draft && release.tag_name !== allowedTag);
  if (blocked.length) {
    throw new Error(
      `Complete or explicitly withdraw the existing draft: ${blocked.map((r) => r.tag_name).join(", ")}`,
    );
  }
}

export async function checkPullRequest({ github, context, number }) {
  const repo = context.repo;
  const { data: pr } = await github.rest.pulls.get({ ...repo, pull_number: number });
  if (pr.base.ref !== "main" || pr.state !== "open") return;
  let problem;
  try {
    validateTitle(pr.title);
    if (isReleasePr(pr)) {
      const releases = await github.paginate(github.rest.repos.listReleases, {
        ...repo,
        per_page: 100,
      });
      assertNoDrafts(releases);
    }
  } catch (error) {
    problem = error.message;
  }
  await github.rest.repos.createCommitStatus({
    ...repo,
    sha: pr.head.sha,
    context: POLICY_CONTEXT,
    state: problem ? "failure" : "success",
    description: (problem || "Title and release policy passed").slice(0, 140),
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

export async function releasePrNeedsRefresh({ github, context }) {
  const prs = await github.paginate(github.rest.pulls.list, {
    ...context.repo,
    state: "open",
    base: "main",
    head: `${context.repo.owner}:${RELEASE_BRANCH}`,
  });
  if (!prs.length) return true;
  if (prs.length > 1) throw new Error("Multiple release pull requests found");
  const pr = prs[0];
  const { data: commit } = await github.rest.git.getCommit({
    ...context.repo,
    commit_sha: pr.head.sha,
  });
  return !commit.message.split(/\r?\n/).includes(`Release-source: ${pr.base.sha}`);
}

export async function updateReleasePr({ github, context, dispatch = true }) {
  const repo = context.repo;
  const prs = await github.paginate(github.rest.pulls.list, {
    ...repo,
    state: "open",
    base: "main",
    head: `${repo.owner}:${RELEASE_BRANCH}`,
  });
  if (prs.length > 1) throw new Error("Multiple release pull requests found");
  if (!prs.length) return;
  const pr = prs[0];
  if (!isReleasePr(pr) || pr.base.ref !== "main") throw new Error("Unexpected release PR target");
  const [manifest, baseManifest, original, baseChangelog] = await Promise.all([
    readText(github, repo, ".release-please-manifest.json", pr.head.sha),
    readText(github, repo, ".release-please-manifest.json", pr.base.sha),
    readText(github, repo, "CHANGELOG.md", pr.head.sha),
    readText(github, repo, "CHANGELOG.md", pr.base.sha),
  ]);
  const version = JSON.parse(manifest)["."];
  const previousVersion = JSON.parse(baseManifest)["."];
  if (version === previousVersion) throw new Error("Release version must differ from main");
  const date = releaseSection(original, version).heading.match(/\d{4}-\d{2}-\d{2}/)?.[0];
  const commits = await collectChanges({ github, repo, previousVersion, head: pr.base.sha });
  const repository = `${repo.owner}/${repo.repo}`;
  const release = renderRelease({
    version,
    previousVersion,
    date,
    repository,
    commits,
    curated: releaseSection(baseChangelog, "Unreleased").notes,
  });
  const changelog = replacePendingRelease(baseChangelog, release);
  const { data: current } = await github.rest.pulls.get({ ...repo, pull_number: pr.number });
  if (current.head.sha !== pr.head.sha || current.base.sha !== pr.base.sha) {
    throw new Error("Release PR moved during changelog generation; rerun the workflow");
  }
  let releaseHead = pr.head.sha;
  if (changelog !== original) {
    // Parent and non-forced ref update prevent overwriting concurrent branch edits.
    const { data: parent } = await github.rest.git.getCommit({ ...repo, commit_sha: pr.head.sha });
    const { data: tree } = await github.rest.git.createTree({
      ...repo,
      base_tree: parent.tree.sha,
      tree: [{ path: "CHANGELOG.md", mode: "100644", type: "blob", content: changelog }],
    });
    const { data: commit } = await github.rest.git.createCommit({
      ...repo,
      tree: tree.sha,
      parents: [pr.head.sha],
      message: `chore(main): release ${version}\n\nRelease-source: ${pr.base.sha}`,
    });
    await github.rest.git.updateRef({
      ...repo,
      ref: `heads/${RELEASE_BRANCH}`,
      sha: commit.sha,
      force: false,
    });
    releaseHead = commit.sha;
  }
  const body = releasePrBody(version, release.count, repository, releaseHead);
  if (body !== current.body) {
    await github.rest.pulls.update({ ...repo, pull_number: pr.number, body });
  }
  await checkPullRequest({ github, context, number: pr.number });
  if (dispatch) {
    // GITHUB_TOKEN cannot trigger pull_request workflows through its own writes.
    // workflow_dispatch is the supported exception and runs CI on this head SHA.
    await github.rest.actions.createWorkflowDispatch({
      ...repo,
      workflow_id: "ci.yml",
      ref: RELEASE_BRANCH,
    });
  }
}

async function readText(github, repo, path, ref) {
  if (!/^[a-f0-9]{40}$/.test(ref)) throw new Error("Expected an immutable source SHA");
  const { data } = await github.rest.repos.getContent({ ...repo, path, ref });
  if (data.type !== "file" || data.encoding !== "base64") throw new Error(`Cannot read ${path}`);
  return Buffer.from(data.content, "base64").toString("utf8");
}

export async function ensureDraftTag({ github, context, tag, sha }) {
  if (!/^v\d+\.\d+\.\d+$/.test(tag) || !/^[a-f0-9]{40}$/.test(sha)) {
    throw new Error("Expected a stable tag and exact release commit SHA");
  }
  const releases = await github.paginate(github.rest.repos.listReleases, {
    ...context.repo,
    per_page: 100,
  });
  assertNoDrafts(releases, tag);
  const matching = releases.filter((r) => r.tag_name === tag);
  if (matching.length !== 1 || !matching[0].draft || matching[0].target_commitish !== sha) {
    throw new Error("Expected one draft bound to the merged release commit");
  }
  let missingTag = false;
  try {
    const { data: ref } = await github.rest.git.getRef({ ...context.repo, ref: `tags/${tag}` });
    if (ref.object.type !== "commit" || ref.object.sha !== sha)
      throw new Error("Existing tag points elsewhere");
  } catch (error) {
    if (error.status !== 404) throw error;
    missingTag = true;
  }
  // The PR body stays concise; the draft gets the full notes from its exact source.
  const changelog = await readText(github, context.repo, "CHANGELOG.md", sha);
  const body = releaseSection(changelog, tag.slice(1)).notes;
  if (!body) throw new Error("Release notes cannot be empty");
  if (matching[0].body !== body) {
    await github.rest.repos.updateRelease({ ...context.repo, release_id: matching[0].id, body });
  }
  if (missingTag)
    await github.rest.git.createRef({ ...context.repo, ref: `refs/tags/${tag}`, sha });
}
