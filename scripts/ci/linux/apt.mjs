import { readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";

const sources = ["/etc/apt/sources.list", "/etc/apt/sources.list.d/ubuntu.sources"];
const packages = [
  "libwebkit2gtk-4.1-dev",
  "libappindicator3-dev",
  "librsvg2-dev",
  "patchelf",
  "sshfs",
  "openssh-sftp-server",
];
const network = [
  "-o",
  "Acquire::Retries=1",
  "-o",
  "Acquire::http::Timeout=15",
  "-o",
  "Acquire::https::Timeout=15",
];

/** Only Ubuntu entries are changed. Third-party repositories and trust policy stay intact. */
export function archiveSource(text, mirror = "https://archive.ubuntu.com/ubuntu/") {
  return text.replace(
    /mirror\+file:\/{1,3}etc\/apt\/apt-mirrors\.txt|https?:\/\/(?:[A-Za-z0-9.-]+\.)?archive\.ubuntu\.com\/ubuntu\/?|https?:\/\/security\.ubuntu\.com\/ubuntu\/?/g,
    mirror,
  );
}

/** A failed primary mirror must not strand CI on that mirror for every rerun. */
export async function installDependencies({
  read = (path) => readFile(path, "utf8"),
  write = (path, value) => writeFile(path, value),
  run = (args, timeout) =>
    execFileSync("apt-get", args, {
      stdio: "inherit",
      timeout,
      env: {
        ...process.env,
        DEBIAN_FRONTEND: "noninteractive",
        NEEDRESTART_MODE: "a",
        LC_ALL: "C",
      },
    }),
  log = console.log,
} = {}) {
  const original = new Map();
  for (const path of sources) {
    try {
      original.set(path, await read(path));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  if (!original.size) throw new Error("No Ubuntu source configuration found");
  let failure;
  try {
    const strategies = [
      ["ubuntu-archive", "https://archive.ubuntu.com/ubuntu/"],
      ["kernel-mirror", "https://mirrors.edge.kernel.org/ubuntu/"],
      ["runner-default", null],
    ];
    for (const [strategy, mirror] of strategies) {
      for (const [path, text] of original)
        await write(path, mirror ? archiveSource(text, mirror) : text);
      log(`Installing Linux dependencies using ${strategy}`);
      try {
        // apt-get update normally exits0 even if required indexes failed to load.
        await run([...network, "-o", "APT::Update::Error-Mode=any", "update"], 90000);
        await run(
          [...network, "-o", "DPkg::Lock::Timeout=60", "install", "-y", ...packages],
          150000,
        );
        return;
      } catch (error) {
        failure = error;
        log(
          `Linux dependency source ${strategy} failed; ${mirror ? "trying the next independent source" : "no sources remain"}`,
        );
      }
    }
    throw new Error("Linux dependency installation failed for all source strategies", {
      cause: failure,
    });
  } finally {
    // Restore the runner configuration even after a failed update/install.
    for (const [path, text] of original) await write(path, text);
  }
}
