import { SHA, readText, resolveTag } from "../github/sources.mjs";
import { releaseChannel } from "../metadata/channels.mjs";
import { SOURCE_PATH } from "../planning/validation.mjs";

/** A human acceptance decision is recorded on the published Beta release itself. */
export const BETA_ACCEPTANCE_MARKER = "<!-- tunnelde:beta-accepted -->";

export function betaCandidates(version, releases) {
  const prefix = `v${version}-beta.`;
  return releases.filter(
    (release) =>
      !release.draft &&
      release.prerelease &&
      release.tag_name?.startsWith(prefix) &&
      releaseChannel(release.tag_name) === "beta",
  );
}

export function acceptedBeta(version, releases) {
  return betaCandidates(version, releases).find((release) =>
    release.body?.includes(BETA_ACCEPTANCE_MARKER),
  );
}

export async function assertAcceptedBeta({ github, repo, stableSha, version }) {
  if (!SHA.test(stableSha) || releaseChannel(`v${version}`) !== "stable")
    throw new Error("Invalid stable release acceptance request");
  const marker = JSON.parse(await readText(github, repo, SOURCE_PATH, stableSha));
  if (!SHA.test(marker.sourceSha)) throw new Error("Invalid stable release source marker");
  const releases = await github.paginate(github.rest.repos.listReleases, {
    ...repo,
    per_page: 100,
  });
  const candidates = betaCandidates(version, releases);
  for (const release of candidates) {
    if (!release.body?.includes(BETA_ACCEPTANCE_MARKER)) continue;
    const sha = await resolveTag(github, repo, release.tag_name);
    const { data: commit } = await github.rest.git.getCommit({ ...repo, commit_sha: sha });
    const source = /^Release-source: ([a-f0-9]{40})$/m.exec(commit.message)?.[1] ?? release.sourceSha;
    if (source === marker.sourceSha) return release.tag_name;
  }
  throw new Error(
    `Stable v${version} requires an accepted, published v${version}-beta.N built from source ${marker.sourceSha}`,
  );
}

export async function acceptBeta({ github, context, tag }) {
  if (releaseChannel(tag) !== "beta") throw new Error("Only Beta releases can be accepted");
  const releases = await github.paginate(github.rest.repos.listReleases, {
    ...context.repo,
    per_page: 100,
  });
  const release = releases.find((item) => item.tag_name === tag);
  if (!release || release.draft || !release.prerelease)
    throw new Error("Acceptance requires a published Beta release");
  if (release.body?.includes(BETA_ACCEPTANCE_MARKER)) return false;
  await github.rest.repos.updateRelease({
    ...context.repo,
    release_id: release.id,
    body: `${release.body?.trimEnd() ?? ""}\n\n${BETA_ACCEPTANCE_MARKER}\n`,
  });
  return true;
}
