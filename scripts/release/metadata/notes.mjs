import { BUILD_VERSION } from "./channels.mjs";

const CATEGORIES = [
  ["breaking", "不兼容变更 | Breaking changes"],
  ["feat", "新增 | New"],
  ["perf", "改进 | Improved"],
  ["fix", "修复 | Fix"],
  ["docs", "文档 | Docs"],
  ["build", "构建 | Build"],
  ["other", "其他 | Other"],
];
const VERSION = BUILD_VERSION;

function markdown(value) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/[\\`*_[\]]/g, "\\$&");
}

function login(value) {
  return /^[a-z\d](?:[a-z\d-]*[a-z\d])?$/i.test(value ?? "") ? value : undefined;
}

export function releaseSection(text, version) {
  if (version !== "Unreleased" && !VERSION.test(version))
    throw new Error("Invalid stable release version");
  const headings = [...text.matchAll(/^## \[([^\]]+)\][^\r\n]*(?:\r?\n|$)/gm)];
  const index = headings.findIndex((heading) => heading[1] === version);
  if (index < 0) throw new Error(`Missing release section for ${version}`);
  const heading = headings[index];
  return {
    heading: heading[0].trimEnd(),
    notes: text.slice(heading.index + heading[0].length, headings[index + 1]?.index).trim(),
  };
}

export function summarizeChanges(commits) {
  const entries = new Map();
  for (const commit of commits) {
    const message = commit.commit.message;
    const subject = message.split(/\r?\n/, 1)[0].replace(/\s*\(#\d+\)$/, "");
    const match = /^(\w+)(?:\(([^)]+)\))?(!)?:\s+(.+)$/.exec(subject);
    if (/^chore(?:\(main\))?: release \d+\.\d+\.\d+/.test(subject)) continue;
    const breaking = Boolean(match?.[3] || /^BREAKING[ -]CHANGE:/m.test(message));
    const type = match?.[1];
    const category = breaking
      ? "breaking"
      : {
          feat: "feat",
          perf: "perf",
          refactor: "perf",
          fix: "fix",
          revert: "fix",
          docs: "docs",
          build: "build",
          ci: "build",
          test: "build",
          style: "perf",
        }[type] || "other";
    const title = (match?.[4] || subject).trim();
    const scope = match?.[2] || "";
    const key = `${category}:${scope}:${title}`
      .normalize("NFKC")
      .toLowerCase()
      .replace(/\s+/g, " ");
    const entry = entries.get(key) || {
      category,
      title,
      scope,
      sources: new Map(),
      authors: new Set(),
    };
    if (!/^[a-f0-9]{40}$/.test(commit.sha)) throw new Error("Invalid source commit SHA");
    const pr = commit.pullRequest;
    const number = pr?.number;
    const source =
      Number.isSafeInteger(number) && number > 0
        ? { label: `#${number}`, path: `pull/${number}` }
        : { label: commit.sha.slice(0, 7), path: `commit/${commit.sha}` };
    entry.sources.set(source.path, source);
    if (pr && pr.merge_commit_sha !== commit.sha) {
      entry.sources.set(`commit/${commit.sha}`, {
        label: commit.sha.slice(0, 7),
        path: `commit/${commit.sha}`,
      });
    }
    const authors = [commit.author?.login, pr?.user?.login];
    for (const trailer of message.matchAll(/^Co-authored-by:.*<([^<>]+)>\s*$/gim)) {
      const coauthor = /^(?:\d+\+)?([a-z\d-]+)@users\.noreply\.github\.com$/i.exec(trailer[1]);
      if (coauthor) authors.push(coauthor[1]);
    }
    for (const author of authors) if (login(author)) entry.authors.add(author);
    entries.set(key, entry);
  }
  return [...entries.values()];
}

export function renderRelease({
  version,
  previousVersion,
  date,
  repository,
  commits,
  curated = "",
}) {
  if (!VERSION.test(version) || !VERSION.test(previousVersion))
    throw new Error("Invalid release version");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("Invalid release date");
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error("Invalid repository");
  const url = `https://github.com/${repository}`;
  const entries = summarizeChanges(commits);
  if (!entries.length) throw new Error("No release changes found");
  const ordered = CATEGORIES.flatMap(([category]) =>
    entries.filter((entry) => entry.category === category),
  );
  const title = (entry) =>
    `${entry.scope ? `**${markdown(entry.scope)}:** ` : ""}${markdown(entry.title)}`;
  const highlights =
    curated.trim().replace(/^### (.+)$/gm, "**$1**") ||
    ordered
      .slice(0, 5)
      .map((entry) => `- ${title(entry)}`)
      .join("\n");
  const groups = CATEGORIES.flatMap(([category, label]) => {
    const changes = entries.filter((entry) => entry.category === category);
    if (!changes.length) return [];
    const lines = changes.map((entry) => {
      const sources = [...entry.sources.values()]
        .map((source) => `[${source.label}](${url}/${source.path})`)
        .join(", ");
      const authors = [...entry.authors]
        .sort()
        .map((author) => `@${author}`)
        .join(" ");
      return `- ${title(entry)} (${sources})${authors ? ` ${authors}` : ""}`;
    });
    return [`### ${label}\n\n${lines.join("\n")}`];
  });
  const contributors = [...new Set(entries.flatMap((entry) => [...entry.authors]))].sort();
  const notes = [
    `### 更新概览 | Highlights\n\n${highlights}`,
    `<details open>\n<summary>详细变更 | Details (${entries.length})</summary>\n\n${groups.join("\n\n")}\n\n</details>`,
    contributors.length
      ? `### 贡献者 | Contributors\n\n${contributors.map((author) => `@${author}`).join(" ")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  return {
    heading: `## [${version}](${url}/compare/v${previousVersion}...v${version}) - ${date}`,
    notes,
    count: entries.length,
  };
}

// Rebuild only the pending version from main's snapshot, leaving historical bytes intact.
export function replacePendingRelease(baseChangelog, release) {
  const headings = [...baseChangelog.matchAll(/^## \[([^\]]+)\][^\r\n]*(?:\r?\n|$)/gm)];
  if (headings[0]?.[1] !== "Unreleased")
    throw new Error("Expected Unreleased before release history");
  const history = headings[1] ? baseChangelog.slice(headings[1].index) : "";
  return `${baseChangelog.slice(0, headings[0].index)}## [Unreleased]\n\n${release.heading}\n\n${release.notes}\n\n${history}`;
}

export function releasePrBody(version, count, repository, sha) {
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error("Expected an immutable changelog SHA");
  // Keep the merge body concise and link to the exact reviewed changelog.
  return `---\n## ${version}\n\n归总 ${count} 项变更并更新版本，详见 [CHANGELOG.md](https://github.com/${repository}/blob/${sha}/CHANGELOG.md)。\n---`;
}

export async function collectChanges({ github, repo, previousVersion, base, head }) {
  if (
    (!base && !VERSION.test(previousVersion)) ||
    (base && !/^[a-f0-9]{40}$/.test(base)) ||
    !/^[a-f0-9]{40}$/.test(head)
  )
    throw new Error("Invalid comparison range");
  const commits = [];
  let total;
  for (let page = 1; ; page++) {
    const { data } = await github.rest.repos.compareCommitsWithBasehead({
      ...repo,
      basehead: `${base || `v${previousVersion}`}...${head}`,
      per_page: 100,
      page,
    });
    if (!["ahead", "identical"].includes(data.status))
      throw new Error("Release source must descend from the previous version tag");
    total ??= data.total_commits;
    commits.push(...data.commits);
    if (commits.length >= total) break;
    if (!data.commits.length) throw new Error("Incomplete release commit history");
  }
  if (commits.length !== total || new Set(commits.map((commit) => commit.sha)).size !== total) {
    throw new Error("Inconsistent release commit history");
  }
  // The association endpoint includes every rebased commit, not just the PR's final SHA.
  for (let offset = 0; offset < commits.length; offset += 4) {
    await Promise.all(
      commits.slice(offset, offset + 4).map(async (commit) => {
        const prs = await github.paginate(github.rest.repos.listPullRequestsAssociatedWithCommit, {
          ...repo,
          commit_sha: commit.sha,
          per_page: 100,
        });
        const candidates = prs.filter(
          (pr) =>
            pr.merged_at &&
            ["dev", "main"].includes(pr.base.ref) &&
            pr.base.repo.full_name === `${repo.owner}/${repo.repo}`,
        );
        candidates.sort(
          (a, b) =>
            Number(b.base.ref === "dev") - Number(a.base.ref === "dev") ||
            Number(b.merge_commit_sha === commit.sha) - Number(a.merge_commit_sha === commit.sha) ||
            a.number - b.number,
        );
        commit.pullRequest = candidates[0];
      }),
    );
  }
  return commits;
}
