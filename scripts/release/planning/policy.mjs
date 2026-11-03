import { setTimeout as delay } from "node:timers/promises";
import { SHA, readText, assertSources } from "../github/sources.mjs";
import {
  RELEASE_BRANCH,
  POLICY_CONTEXT,
  SOURCE_PATH,
  validateTitle,
  isReleasePr,
  checkPromotionCommit,
} from "./validation.mjs";

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
      const marker = JSON.parse(await readText(github, repo, SOURCE_PATH, pr.head.sha));
      await checkPromotionCommit(github, repo, pr.head.sha, marker);
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
