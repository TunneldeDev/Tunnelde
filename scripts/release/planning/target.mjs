import { readText } from "../github/sources.mjs";
import { compareReleaseTags, releaseChannel } from "../metadata/channels.mjs";

export const TARGET_PATH = ".github/release-target.json";

// A source-controlled milestone is scoped to one stable baseline, not a global
// version override. Completed milestones do not affect the next release cycle.
export function releaseTarget(previousVersion, declaration) {
  if (
    !declaration ||
    Array.isArray(declaration) ||
    typeof declaration !== "object" ||
    Object.keys(declaration).sort().join(",") !== "baseVersion,schemaVersion,targetVersion" ||
    declaration.schemaVersion !== 1
  )
    throw new Error("Invalid release target declaration");
  const { baseVersion, targetVersion } = declaration;
  for (const version of [previousVersion, baseVersion, targetVersion]) {
    if (typeof version !== "string" || releaseChannel(`v${version}`) !== "stable")
      throw new Error("Release targets require canonical stable versions");
  }
  const compare = (left, right) => compareReleaseTags(`v${left}`, `v${right}`);
  if (compare(targetVersion, baseVersion) <= 0)
    throw new Error("Release target must be newer than its baseline");
  if (compare(previousVersion, targetVersion) >= 0) return undefined;
  if (previousVersion !== baseVersion)
    throw new Error("Release target baseline changed; review the target declaration");
  return targetVersion;
}

export async function readReleaseTarget(github, repo, source, previousVersion) {
  let text;
  try {
    text = await readText(github, repo, TARGET_PATH, source);
  } catch (error) {
    if (error.status === 404) return undefined;
    throw error;
  }
  return releaseTarget(previousVersion, JSON.parse(text));
}
