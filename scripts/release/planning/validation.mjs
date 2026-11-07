import { SHA, sourceTrees, readText } from "../github/sources.mjs";
import { VERSION_PATHS } from "../metadata/version-files.mjs";

export const RELEASE_BRANCH = "release/dev-to-main";
export const POLICY_CONTEXT = "PR policy";
export const SOURCE_PATH = ".github/release-source.json";
const RELEASE_METADATA = new Set([...VERSION_PATHS, "CHANGELOG.md", SOURCE_PATH]);
const RETIRED_HELPER_METADATA = new Set(["native-helpers/Cargo.toml", "native-helpers/Cargo.lock"]);

// A previously promoted main has renumbered these historical files. Removing the
// helper from dev must not look like an unmerged main hotfix. Only the package's
// version may differ; real helper changes still stop promotion.
async function retiredVersionOnly(github, repo, path, main, source, trees) {
  if (
    !RETIRED_HELPER_METADATA.has(path) ||
    trees[2].has(path) ||
    !trees[0].has(path) ||
    !trees[1].has(path)
  )
    return false;
  const versions = await Promise.all(
    [main, source].map((ref) => readText(github, repo, path, ref)),
  );
  const pattern = path.endsWith(".lock")
    ? /(\[\[package\]\]\r?\nname = "tunnelde-agent"\r?\nversion = ")[^"]+(")/
    : /(\[package\][\s\S]*?\nversion = ")[^"]+(")/;
  return (
    versions.every((text) => pattern.test(text)) &&
    versions[0].replace(pattern, "$1<retired>$2") === versions[1].replace(pattern, "$1<retired>$2")
  );
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

export async function checkPromotionCommit(github, repo, sha, marker) {
  if (
    marker.history !== "merge" ||
    !SHA.test(marker.baseSha) ||
    !SHA.test(marker.sourceSha) ||
    !/^\d+\.\d+\.\d+$/.test(marker.version)
  )
    throw new Error("Release PR must be regenerated to preserve dev history");
  const { data: commit } = await github.rest.git.getCommit({ ...repo, commit_sha: sha });
  if (
    commit.parents.length !== 2 ||
    commit.parents[0].sha !== marker.baseSha ||
    commit.parents[1].sha !== marker.sourceSha
  )
    throw new Error("Release preparation must retain the reviewed main and dev parents");
  const trees = await sourceTrees(github, repo, [sha, marker.sourceSha]);
  for (const path of new Set(trees.flatMap((tree) => [...tree.keys()]))) {
    if (!RELEASE_METADATA.has(path) && trees[0].get(path) !== trees[1].get(path))
      throw new Error(`Release preparation changes dev content outside metadata (${path})`);
  }
  return commit;
}

export async function assertMainHasNoUnpromotedChanges(github, repo, main, dev, marker) {
  if (!marker.baseSha) return; // Initial migration, before the first dev promotion.
  const trees = await sourceTrees(github, repo, [main, marker.sourceSha, dev]);
  for (const path of new Set(trees.flatMap((tree) => [...tree.keys()]))) {
    if (
      !RELEASE_METADATA.has(path) &&
      trees[0].get(path) !== trees[1].get(path) &&
      trees[0].get(path) !== trees[2].get(path) &&
      !(await retiredVersionOnly(github, repo, path, main, marker.sourceSha, trees))
    )
      throw new Error(
        `Main has changes outside release metadata (${path}); merge main into dev before promoting`,
      );
  }
}
