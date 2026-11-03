import { SHA, branchSha, readText, assertSources } from "../github/sources.mjs";
import { SOURCE_PATH, checkPromotionCommit } from "../planning/validation.mjs";
import { releaseSection } from "../metadata/notes.mjs";
import { ensureRelease } from "./releases.mjs";

export async function prepareStable({ github, context }) {
  const repo = context.repo;
  const sha = await branchSha(github, repo, "main");
  const marker = JSON.parse(await readText(github, repo, SOURCE_PATH, sha));
  if (!marker.baseSha) return ""; // Migration does not invent another stable release.
  const { data: commit } = await github.rest.git.getCommit({ ...repo, commit_sha: sha });
  if (marker.history === "merge") {
    if (commit.parents.length !== 2 || commit.parents[0].sha !== marker.baseSha)
      throw new Error("Main must preserve the reviewed release with Create a merge commit");
    const prepared = await checkPromotionCommit(github, repo, commit.parents[1].sha, marker);
    if (commit.tree.sha !== prepared.tree.sha)
      throw new Error("Merged main content differs from the reviewed release tree");
  } else if (commit.parents.length !== 1 || commit.parents[0].sha !== marker.baseSha)
    throw new Error("Main is not the reviewed release promotion");
  const version = JSON.parse(await readText(github, repo, "package.json", sha)).version;
  if (version !== marker.version || !SHA.test(marker.sourceSha))
    throw new Error("Release metadata mismatch");
  const body = releaseSection(await readText(github, repo, "CHANGELOG.md", sha), version).notes;
  await assertSources(github, repo, { main: sha });
  return ensureRelease({ github, context, tag: `v${version}`, sha, body });
}
