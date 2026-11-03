import { SHA, branchSha, readText, resolveTag, assertAncestor } from "../github/sources.mjs";
import { compareReleaseTags, releaseChannel, releaseTitle } from "../metadata/channels.mjs";
import { VERSION_PATHS, assertVersionContents } from "../metadata/version-files.mjs";
import { releaseSection } from "../metadata/notes.mjs";

export async function ensureRelease({
  github,
  context,
  tag,
  sha,
  body,
  prerelease = releaseChannel(tag) !== "stable",
}) {
  if (!SHA.test(sha) || (releaseChannel(tag) !== "stable") !== prerelease || !body?.trim())
    throw new Error("Invalid release source, channel or notes");
  const repo = context.repo;
  // Tag must exist before the draft, avoiding GitHub's untagged draft conversion.
  try {
    if ((await resolveTag(github, repo, tag)) !== sha)
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
    if (release.target_commitish !== sha || release.prerelease !== prerelease)
      throw new Error("Release source/channel mismatch");
    return release.draft ? tag : "";
  }
  await github.rest.repos.createRelease({
    ...repo,
    tag_name: tag,
    target_commitish: sha,
    name: releaseTitle(tag),
    body,
    draft: true,
    prerelease,
    make_latest: "false",
  });
  return tag;
}

export async function prepareTaggedRelease({ github, context, tag }) {
  const channel = releaseChannel(tag);
  const sha = await resolveTag(github, context.repo, tag);
  const version = tag.slice(1);
  const files = Object.fromEntries(
    await Promise.all(
      VERSION_PATHS.map(async (path) => [path, await readText(github, context.repo, path, sha)]),
    ),
  );
  // Validate every manifest before creating any public-facing draft.
  assertVersionContents(files, version);
  const { data: commit } = await github.rest.git.getCommit({ ...context.repo, commit_sha: sha });
  const source = /^Release-source: ([a-f0-9]{40})$/m.exec(commit.message)?.[1];
  if (channel === "stable") await assertAncestor(github, context.repo, sha, "main");
  else {
    if (source && (commit.parents.length !== 1 || commit.parents[0].sha !== source))
      throw new Error("Invalid prepared release parent");
    await assertAncestor(github, context.repo, source || sha, "dev");
  }
  const body = releaseSection(
    await readText(github, context.repo, "CHANGELOG.md", sha),
    version,
  ).notes;
  return ensureRelease({ github, context, tag, sha, body });
}

export async function publishRelease({ github, context, tag }) {
  const repo = context.repo;
  const channel = releaseChannel(tag);
  const prerelease = channel !== "stable";
  const releases = await github.paginate(github.rest.repos.listReleases, {
    ...repo,
    per_page: 100,
  });
  const release = releases.find((item) => item.tag_name === tag);
  if (!release?.draft || release.prerelease !== prerelease)
    throw new Error("Expected matching draft channel");
  const sha = await resolveTag(github, repo, tag);
  if (sha !== release.target_commitish) throw new Error("Release tag moved");
  if (prerelease) {
    const { data: commit } = await github.rest.git.getCommit({
      ...repo,
      commit_sha: sha,
    });
    const source = /^Release-source: ([a-f0-9]{40})$/m.exec(commit.message)?.[1];
    if (source && (commit.parents.length !== 1 || commit.parents[0].sha !== source))
      throw new Error("Invalid prepared release parent");
    // A tagged snapshot remains valid when dev advances during the build.
    await assertAncestor(github, repo, source || sha, "dev");
  } else await assertAncestor(github, repo, sha, "main");
  const newerStable = releases.some((item) => {
    if (item.draft || item.prerelease) return false;
    try {
      return (
        releaseChannel(item.tag_name) === "stable" && compareReleaseTags(item.tag_name, tag) > 0
      );
    } catch {
      return false;
    }
  });
  const currentStable = !prerelease && (await branchSha(github, repo, "main")) === sha;
  await github.rest.repos.updateRelease({
    ...repo,
    release_id: release.id,
    draft: false,
    prerelease,
    make_latest: !currentStable || newerStable ? "false" : "true",
    name: releaseTitle(tag),
  });
}
