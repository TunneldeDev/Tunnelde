// Keep version validation, release titles and channel identity shared by all publishers.
const CORE = "(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)";
const NUMBER = "(?:0|[1-9]\\d*)";
const BETA_SEQUENCE = `(?:0[1-9]|[1-9]\\d|\\.${NUMBER}(?:\\.${NUMBER})?)`;
export const BUILD_VERSION = new RegExp(
  `^${CORE}(?:-beta${BETA_SEQUENCE}(?:\\.d\\.${NUMBER}\\.g[a-f0-9]{7,40})?|-alpha\\.1\\.d\\.${NUMBER}\\.g[a-f0-9]{7,40})?$`,
);

// Historical versions remain readable for comparison and updater compatibility.
// Publishing has a stricter policy than reading previously published metadata.
export const PUBLISH_VERSION = new RegExp(
  `^${CORE}(?:-beta\\.[1-9](?:\\.d\\.${NUMBER}\\.g[a-f0-9]{7,40})?|-alpha\\.1\\.d\\.${NUMBER}\\.g[a-f0-9]{7,40})?$`,
);

export function assertPublishableTag(tag) {
  if (typeof tag !== "string" || !tag.startsWith("v") || !PUBLISH_VERSION.test(tag.slice(1)))
    throw new Error(
      "Release policy requires vX.Y.Z, beta.1–beta.9, or a source-derived Nightly. Promote the reviewed stable release before preparing another Beta; do not reuse retired numbers.",
    );
}

/** Historical Beta tags reserve their original sequence, including retired releases. */
export function betaSequence(tag) {
  if (releaseChannel(tag) !== "beta") throw new Error("Expected a Beta milestone tag");
  return BigInt(/-beta\.?(\d+)/.exec(tag)[1]);
}

export function betaVersion(version, sequence) {
  if (typeof sequence !== "bigint" || sequence < 1n || sequence > 9n)
    throw new Error(
      "Beta sequence exhausted (1–9). Promote the reviewed release to main before preparing another Beta. Never reuse retired numbers or publish beta.10.",
    );
  return `${version}-beta.${sequence}`;
}

export function releaseChannel(tag) {
  if (typeof tag !== "string" || !tag.startsWith("v") || !BUILD_VERSION.test(tag.slice(1)))
    throw new Error("Invalid release tag");
  return tag.includes(".d.") ? "nightly" : tag.includes("-beta") ? "beta" : "stable";
}

export function releaseTitle(tag) {
  return releaseChannel(tag) === "nightly" ? `${tag} (Nightly)` : tag;
}

export function compareReleaseTags(left, right) {
  releaseChannel(left);
  releaseChannel(right);
  const [aCore, aPre] = left.slice(1).split("-");
  const [bCore, bPre] = right.slice(1).split("-");
  const compare = (a, b) => {
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      if (a[i] === b[i]) continue;
      if (a[i] === undefined || b[i] === undefined) return a[i] === undefined ? -1 : 1;
      const numericA = /^\d+$/.test(a[i]);
      const numericB = /^\d+$/.test(b[i]);
      if (numericA !== numericB) return numericA ? -1 : 1;
      return (numericA ? BigInt(a[i]) < BigInt(b[i]) : a[i] < b[i]) ? -1 : 1;
    }
    return 0;
  };
  return (
    compare(aCore.split("."), bCore.split(".")) ||
    (!aPre || !bPre
      ? aPre === bPre
        ? 0
        : aPre
          ? -1
          : 1
      : compare(aPre.split("."), bPre.split(".")))
  );
}
