import i18n from "@/i18n/i18n";

const GROUPS = [
  "general",
  "appearance",
  "workspace",
  "terminal",
  "files",
  "transfers",
  "editor",
  "monitoring",
  "shortcuts",
  "network",
  "updates",
] as const;

/** Only the host-generated profile name and known group IDs enter consent UI. */
export function profileActivationReview(params: Record<string, unknown>): string {
  const { name, groups } = params;
  if (
    typeof name !== "string" ||
    !name.trim() ||
    name !== name.trim() ||
    Array.from(name).length > 64 ||
    /[\p{Cc}\uD800-\uDFFF]/u.test(name) ||
    !Array.isArray(groups) ||
    groups.length > GROUPS.length ||
    new Set(groups).size !== groups.length ||
    groups.some((group) => !GROUPS.includes(group as (typeof GROUPS)[number]))
  ) {
    throw new Error("profiles.mutation.invalidRequest");
  }
  const labels = (groups as Array<(typeof GROUPS)[number]>).map((group) =>
    i18n.t(`profiles.groups.${group}`),
  );
  return i18n.t("profiles.activationReview", {
    name,
    groups: labels.length ? labels.join(", ") : i18n.t("profiles.noPublicChanges"),
  });
}
