import { releaseChannel } from "../metadata/channels.mjs";
import { retryGithubRead } from "./reads.mjs";

export const SHA = /^[a-f0-9]{40}$/;

export async function readText(github, repo, path, ref, wait) {
  if (!SHA.test(ref)) throw new Error("Expected an immutable source SHA");
  const { data } = await retryGithubRead(
    () => github.rest.repos.getContent({ ...repo, path, ref }),
    wait,
  );
  if (data.type !== "file" || data.encoding !== "base64") throw new Error(`Cannot read ${path}`);
  return Buffer.from(data.content, "base64").toString("utf8");
}

export async function branchSha(github, repo, branch) {
  const { data } = await github.rest.git.getRef({ ...repo, ref: `heads/${branch}` });
  if (data.object.type !== "commit" || !SHA.test(data.object.sha))
    throw new Error("Invalid branch source");
  return data.object.sha;
}

export async function assertSources(github, repo, sources) {
  for (const [branch, sha] of Object.entries(sources)) {
    if ((await branchSha(github, repo, branch)) !== sha)
      throw new Error(`${branch} moved during preparation; rerun the workflow`);
  }
}

export async function commitTree({ github, repo, source, parent, mergeParent, contents, message }) {
  const { data: original } = await github.rest.git.getCommit({ ...repo, commit_sha: source });
  const { data: tree } = await github.rest.git.createTree({
    ...repo,
    base_tree: original.tree.sha,
    tree: Object.entries(contents).map(([path, content]) => ({
      path,
      mode: "100644",
      type: "blob",
      content,
    })),
  });
  const { data: commit } = await github.rest.git.createCommit({
    ...repo,
    tree: tree.sha,
    parents: mergeParent ? [parent, mergeParent] : [parent],
    message,
  });
  return commit.sha;
}

export async function sourceTrees(github, repo, sources) {
  return Promise.all(
    sources.map(async (sha) => {
      const { data } = await github.rest.git.getTree({ ...repo, tree_sha: sha, recursive: "true" });
      if (data.truncated) throw new Error("Cannot safely compare truncated source trees");
      return new Map(
        data.tree
          .filter((entry) => entry.type !== "tree")
          .map((entry) => [entry.path, `${entry.mode}:${entry.sha}`]),
      );
    }),
  );
}

export async function resolveTag(github, repo, tag) {
  releaseChannel(tag);
  const { data } = await github.rest.git.getRef({ ...repo, ref: `tags/${tag}` });
  let object = data.object;
  // Accept both lightweight and annotated version tags, always pinning the commit.
  for (let depth = 0; object.type === "tag" && depth < 8; depth++) {
    const { data: annotation } = await github.rest.git.getTag({ ...repo, tag_sha: object.sha });
    object = annotation.object;
  }
  if (object.type !== "commit" || !SHA.test(object.sha)) throw new Error("Invalid tag source");
  return object.sha;
}

export async function assertAncestor(github, repo, source, branch) {
  if (!SHA.test(source)) throw new Error("Missing immutable release source");
  const head = await branchSha(github, repo, branch);
  if (source === head) return;
  const { data } = await github.rest.repos.compareCommitsWithBasehead({
    ...repo,
    basehead: `${source}...${head}`,
  });
  if (!["ahead", "identical"].includes(data.status))
    throw new Error(`Release source is no longer in ${branch} history`);
}
