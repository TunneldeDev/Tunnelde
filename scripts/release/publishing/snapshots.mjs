import { assertSources, commitTree, resolveTag } from "../github/sources.mjs";
import {
  betaSequence,
  betaVersion,
  compareReleaseTags,
  releaseChannel,
} from "../metadata/channels.mjs";
import { versionContents } from "../metadata/version-files.mjs";
import { replacePendingRelease } from "../metadata/notes.mjs";
import { ensureRelease } from "./releases.mjs";

function betaMilestone(tag) {
  try {
    return releaseChannel(tag) === "beta";
  } catch {
    return false;
  }
}

function snapshotNotes(plan, version) {
  return {
    ...plan.release,
    heading: plan.release.heading
      .replace(`[${plan.version}]`, `[${version}]`)
      .replace(`...v${plan.version})`, `...v${version})`),
  };
}

export async function prepareBeta({ github, context, plan, legacyUpdaterBridge = false }) {
  if (!plan.version) return "";
  const repo = context.repo;
  await assertSources(github, repo, { dev: plan.dev });
  // Only explicit Beta preparations allocate betaNN; legacy beta.N reserves its number.
  const { data: refs } = await github.rest.git.listMatchingRefs({
    ...repo,
    ref: `tags/v${plan.version}-beta`,
  });
  const tags = refs
    .map((ref) => ({ ...ref, tag: ref.ref.replace(/^refs\/tags\//, "") }))
    .filter(({ tag }) => betaMilestone(tag) && tag.startsWith(`v${plan.version}-beta`))
    .sort((a, b) => compareReleaseTags(b.tag, a.tag));
  if (legacyUpdaterBridge && tags.some(({ tag }) => /-beta\d/.test(tag)))
    throw new Error("A legacy updater bridge must be published before compact Beta tags exist");
  const latest = tags[0];
  const body = `Development build from ${plan.dev}.\n\n${plan.release.notes}`;
  if (latest) {
    const existingSha = await resolveTag(github, repo, latest.tag);
    const { data: commit } = await github.rest.git.getCommit({
      ...repo,
      commit_sha: existingSha,
    });
    if (/^Release-source: ([a-f0-9]{40})$/m.exec(commit.message)?.[1] === plan.dev) {
      await assertSources(github, repo, { dev: plan.dev });
      return ensureRelease({
        github,
        context,
        tag: latest.tag,
        sha: existingSha,
        body,
      });
    }
  }
  const sequence =
    tags.reduce((highest, { tag }) => {
      const number = betaSequence(tag);
      return number > highest ? number : highest;
    }, 0n) + 1n;
  const compactVersion = betaVersion(plan.version, sequence);
  // A one-time legacy-named build lets older clients acquire compact channel support by OTA.
  const version = legacyUpdaterBridge ? `${plan.version}-beta.${sequence}` : compactVersion;
  const release = snapshotNotes(plan, version);
  const sha = await commitTree({
    github,
    repo: context.repo,
    source: plan.dev,
    parent: plan.dev,
    contents: {
      ...versionContents(plan.files, version),
      "CHANGELOG.md": replacePendingRelease(plan.history, release),
    },
    message: `chore: release ${version}\n\nRelease-source: ${plan.dev}`,
  });
  await assertSources(github, context.repo, { dev: plan.dev });
  return ensureRelease({
    github,
    context,
    tag: `v${version}`,
    sha,
    body,
  });
}

export async function prepareNightly({ github, context, plan }) {
  if (!plan.version) return "";
  if (!Number.isSafeInteger(plan.distance) || plan.distance < 1)
    throw new Error("Invalid Nightly commit distance");
  await assertSources(github, context.repo, { dev: plan.dev });
  let base = `${plan.version}-alpha.1`;
  let distance = plan.distance;
  const { data: refs } = await github.rest.git.listMatchingRefs({
    ...context.repo,
    ref: `tags/v${plan.version}-beta`,
  });
  const betas = refs
    .map((ref) => ref.ref.replace(/^refs\/tags\//, ""))
    .filter((tag) => betaMilestone(tag))
    .sort((a, b) => compareReleaseTags(b, a));
  for (const beta of betas) {
    const betaSha = await resolveTag(github, context.repo, beta);
    const { data: commit } = await github.rest.git.getCommit({
      ...context.repo,
      commit_sha: betaSha,
    });
    const source = /^Release-source: ([a-f0-9]{40})$/m.exec(commit.message)?.[1] || betaSha;
    if (source === plan.dev) return ""; // Beta already represents this exact snapshot.
    const { data: comparison } = await github.rest.repos.compareCommitsWithBasehead({
      ...context.repo,
      basehead: `${source}...${plan.dev}`,
    });
    if (!["ahead", "identical"].includes(comparison.status)) continue;
    if (!Number.isSafeInteger(comparison.total_commits) || comparison.total_commits < 1)
      throw new Error("Invalid Nightly commit distance from Beta");
    base = beta.slice(1);
    distance = comparison.total_commits;
    break;
  }
  // Numeric distance is its own SemVer identifier, so 1000 correctly sorts after 999.
  const version = `${base}.d.${distance}.g${plan.dev.slice(0, 12)}`;
  const tag = `v${version}`;
  const body = `Nightly development snapshot from ${plan.dev}.\n\n${plan.release.notes}`;
  let sha;
  try {
    sha = await resolveTag(github, context.repo, tag);
    const { data: commit } = await github.rest.git.getCommit({ ...context.repo, commit_sha: sha });
    if (/^Release-source: ([a-f0-9]{40})$/m.exec(commit.message)?.[1] !== plan.dev)
      throw new Error("Nightly tag belongs to a different source");
  } catch (error) {
    if (error.status !== 404) throw error;
    sha = await commitTree({
      github,
      repo: context.repo,
      source: plan.dev,
      parent: plan.dev,
      contents: {
        ...versionContents(plan.files, version),
        "CHANGELOG.md": replacePendingRelease(plan.history, snapshotNotes(plan, version)),
      },
      message: `chore: release ${version}\n\nRelease-source: ${plan.dev}`,
    });
  }
  await assertSources(github, context.repo, { dev: plan.dev });
  return ensureRelease({ github, context, tag, sha, body });
}
