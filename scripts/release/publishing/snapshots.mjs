import { assertSources, commitTree, resolveTag } from "../github/sources.mjs";
import {
  betaSequence,
  betaVersion,
  assertPublishableTag,
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

export async function prepareBeta({ github, context, plan }) {
  if (!plan.version) return "";
  const repo = context.repo;
  await assertSources(github, repo, { dev: plan.dev });
  // Only explicit Beta preparations allocate a milestone; historical tags reserve numbers.
  const { data: refs } = await github.rest.git.listMatchingRefs({
    ...repo,
    ref: `tags/v${plan.version}-beta`,
  });
  const tags = refs
    .map((ref) => ({ ...ref, tag: ref.ref.replace(/^refs\/tags\//, "") }))
    .filter(({ tag }) => betaMilestone(tag) && tag.startsWith(`v${plan.version}-beta`))
    .sort((a, b) => compareReleaseTags(b.tag, a.tag));
  const latest = tags[0];
  const body = `Development build from ${plan.dev}.\n\n${plan.release.notes}`;
  if (latest) {
    const existingSha = await resolveTag(github, repo, latest.tag);
    const { data: commit } = await github.rest.git.getCommit({
      ...repo,
      commit_sha: existingSha,
    });
    if (/^Release-source: ([a-f0-9]{40})$/m.exec(commit.message)?.[1] === plan.dev) {
      assertPublishableTag(latest.tag);
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
  const version = betaVersion(plan.version, sequence);
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
