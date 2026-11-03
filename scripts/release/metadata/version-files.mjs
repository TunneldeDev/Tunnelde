import { BUILD_VERSION } from "./channels.mjs";

export const VERSION_PATHS = [
  "package.json",
  "src-tauri/tauri.conf.json",
  "src-tauri/Cargo.toml",
  "src-tauri/Cargo.lock",
  "native-helpers/Cargo.toml",
  "native-helpers/Cargo.lock",
  ".release-please-manifest.json",
  "CITATION.cff",
];

// Shared by local preparation and Git tree generation; validates before writing anything.
export function versionContents(contents, version) {
  if (!BUILD_VERSION.test(version)) throw new Error(`invalid version: ${version}`);
  return Object.fromEntries(
    VERSION_PATHS.map((path) => {
      const text = contents[path];
      if (typeof text !== "string") throw new Error(`Missing version file: ${path}`);
      if (path.endsWith(".json")) {
        const value = JSON.parse(text);
        value[path === ".release-please-manifest.json" ? "." : "version"] = version;
        return [path, `${JSON.stringify(value, null, 2)}\n`];
      }
      const pattern =
        path === "CITATION.cff"
          ? /^version: [^\r\n]+$/m
          : path.endsWith(".lock")
            ? new RegExp(
                `(\\[\\[package\\]\\]\\r?\\nname = "${path.startsWith("native") ? "tunnelde-agent" : "tunnelde"}"\\r?\\nversion = ")[^"]+(")`,
              )
            : /(\[package\][\s\S]*?\nversion = ")[^"]+(")/;
      if (!pattern.test(text)) throw new Error(`Cannot locate version in ${path}`);
      return [
        path,
        text.replace(pattern, path === "CITATION.cff" ? `version: ${version}` : `$1${version}$2`),
      ];
    }),
  );
}

export function assertVersionContents(contents, version) {
  const normalized = (path, text) => {
    if (path.endsWith(".json")) return JSON.stringify(JSON.parse(text));
    if (path === "CITATION.cff")
      return text.replace(/^version: ["']?([^\r\n"']+)["']?$/m, "version: $1");
    return text;
  };
  const expected = versionContents(contents, version);
  for (const path of VERSION_PATHS) {
    if (normalized(path, contents[path]) !== normalized(path, expected[path]))
      throw new Error(`Release tag does not match version manifests (${path})`);
  }
}
