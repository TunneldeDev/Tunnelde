import type { FsSource, Listing } from "@/lib/api/types";

export interface PathCrumb {
  name: string;
  path: string;
}

/** Preserve drive/UNC roots and treat backslashes as file names on POSIX sources. */
export function pathCrumbs(path: string, source: FsSource): PathCrumb[] {
  if (!path) return [];
  const windows = source.kind === "local" && !path.startsWith("/");
  const separator = windows ? "\\" : "/";
  const normalized = windows ? path.replaceAll("/", "\\") : path;
  const root = windows
    ? normalized.match(/^(?:[A-Za-z]:\\|\\\\[^\\]+\\[^\\]+\\?)/)?.[0]
    : normalized.startsWith("/")
      ? "/"
      : undefined;
  if (!root) return [{ name: path, path }];
  const crumbs = [{ name: root === "/" ? "/" : root.replace(/\\$/, ""), path: root }];
  for (const name of normalized.slice(root.length).split(separator).filter(Boolean)) {
    const parent = crumbs[crumbs.length - 1]!.path;
    crumbs.push({
      name,
      path: `${parent.endsWith(separator) ? parent : parent + separator}${name}`,
    });
  }
  return crumbs;
}

/** Retain only the verified branch leading to the next directory. */
export function columnAncestors(
  ancestors: readonly Listing[],
  current: Listing | null,
  next: Listing,
): Listing[] {
  const chain = current ? [...ancestors, current] : [];
  const existing = chain.findIndex((listing) => listing.path === next.path);
  if (existing >= 0) return chain.slice(0, existing);
  const parent = chain.findIndex((listing) =>
    listing.entries.some((entry) => entry.isDir && entry.path === next.path),
  );
  return parent >= 0 ? chain.slice(0, parent + 1) : [];
}
