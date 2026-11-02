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

// Release Please inserts its generated section below Unreleased. Move curated notes
// into that release once, preserving the historical changelog byte for byte.
export function foldCuratedNotes(text, version) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("Invalid stable release version");
  const headings = [...text.matchAll(/^## \[([^\]]+)\][^\r\n]*(?:\r?\n|$)/gm)];
  const unreleased = headings.find((heading) => heading[1] === "Unreleased");
  if (!unreleased) throw new Error("Missing Unreleased section");
  const release = headings.find((heading) => heading[1] !== "Unreleased");
  if (!release || release[1] !== version || !headings.slice(0, 2).includes(unreleased)) {
    throw new Error(`Missing first release section for ${version}`);
  }
  const body = (heading) => {
    const next = headings[headings.indexOf(heading) + 1];
    return text.slice(heading.index + heading[0].length, next?.index ?? text.length).trim();
  };
  const curated = body(unreleased);
  if (!curated && unreleased.index < release.index) return text;
  const prefix = text.slice(0, headings[0].index);
  const history = headings[2] ? text.slice(headings[2].index) : "";
  const notes = [curated ? `### Maintainer notes\n\n${curated}` : "", body(release)]
    .filter(Boolean)
    .join("\n\n");
  return `${prefix}## [Unreleased]\n\n${release[0].trimEnd()}\n\n${notes}\n${history ? `\n${history}` : ""}`;
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
  const { data: manifest } = await github.rest.repos.getContent({
    ...repo,
    path: ".release-please-manifest.json",
    ref: pr.head.sha,
  });
  const version = JSON.parse(Buffer.from(manifest.content, "base64").toString("utf8"))["."];
  const { data: changelog } = await github.rest.repos.getContent({
    ...repo,
    path: "CHANGELOG.md",
    ref: pr.head.sha,
  });
  const original = Buffer.from(changelog.content, "base64").toString("utf8");
  const folded = foldCuratedNotes(original, version);
  if (folded !== original) {
    // Updating one file with its blob SHA also protects against concurrent edits.
    await github.rest.repos.createOrUpdateFileContents({
      ...repo,
      branch: RELEASE_BRANCH,
      path: "CHANGELOG.md",
      sha: changelog.sha,
      message: `chore(main): release ${version}`,
      content: Buffer.from(folded).toString("base64"),
    });
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
  try {
    const { data: ref } = await github.rest.git.getRef({ ...context.repo, ref: `tags/${tag}` });
    if (ref.object.type !== "commit" || ref.object.sha !== sha)
      throw new Error("Existing tag points elsewhere");
  } catch (error) {
    if (error.status !== 404) throw error;
    await github.rest.git.createRef({ ...context.repo, ref: `refs/tags/${tag}`, sha });
  }
}
