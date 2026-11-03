// Keep version validation, release titles and channel identity shared by all publishers.
const CORE = "(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)";
const NUMBER = "(?:0|[1-9]\\d*)";
export const BUILD_VERSION = new RegExp(
  `^${CORE}(?:-beta\\.${NUMBER}(?:\\.${NUMBER})?(?:\\.d\\.${NUMBER}\\.g[a-f0-9]{7,40})?|-alpha\\.1\\.d\\.${NUMBER}\\.g[a-f0-9]{7,40})?$`,
);

export function releaseChannel(tag) {
  if (typeof tag !== "string" || !tag.startsWith("v") || !BUILD_VERSION.test(tag.slice(1)))
    throw new Error("Invalid release tag");
  return tag.includes(".d.") ? "nightly" : tag.includes("-beta.") ? "beta" : "stable";
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
