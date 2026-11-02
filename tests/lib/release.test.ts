import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const temporary: string[] = [];
afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture(notes = "- Fix a reproducible bug.") {
  const root = mkdtempSync(join(tmpdir(), "tunnelde-release-test-"));
  temporary.push(root);
  mkdirSync(join(root, "scripts/release"), { recursive: true });
  mkdirSync(join(root, "src-tauri"));
  mkdirSync(join(root, "native-helpers"));
  writeFileSync(
    join(root, "native-helpers/Cargo.toml"),
    '[package]\nname = "tunnelde-agent"\nversion = "0.18.1"\n',
  );
  writeFileSync(
    join(root, "native-helpers/Cargo.lock"),
    '[[package]]\nname = "tunnelde-agent"\nversion = "0.18.1"\n',
  );
  for (const name of ["version", "changelog", "release", "verify-assets"]) {
    copyFileSync(
      join(process.cwd(), `scripts/release/${name}.mjs`),
      join(root, `scripts/release/${name}.mjs`),
    );
  }
  writeFileSync(join(root, "package.json"), JSON.stringify({ version: "0.18.1" }));
  writeFileSync(join(root, "src-tauri/tauri.conf.json"), JSON.stringify({ version: "0.18.1" }));
  writeFileSync(
    join(root, "src-tauri/Cargo.toml"),
    '[package]\nname = "tunnelde"\nversion = "0.18.1"\n',
  );
  writeFileSync(
    join(root, "src-tauri/Cargo.lock"),
    '[[package]]\nname = "tunnelde"\nversion = "0.18.1"\n',
  );
  writeFileSync(
    join(root, "CHANGELOG.md"),
    `# Changelog\n\n## [Unreleased]\n\n${notes}\n\n## [0.18.1]\n\n- Old notes.\n`,
  );
  return {
    root,
    run: (script: string, ...args: string[]) =>
      spawnSync(process.execPath, [join(root, `scripts/release/${script}.mjs`), ...args], {
        cwd: root,
        encoding: "utf8",
      }),
    read: (name: string) => readFileSync(join(root, name), "utf8"),
  };
}

describe("release preparation", () => {
  it("leaves all version files untouched when release notes are empty", () => {
    const f = fixture("");
    const names = [
      "package.json",
      "src-tauri/Cargo.toml",
      "src-tauri/Cargo.lock",
      "src-tauri/tauri.conf.json",
      "native-helpers/Cargo.toml",
      "native-helpers/Cargo.lock",
      "CHANGELOG.md",
    ];
    const before = names.map(f.read);
    expect(f.run("release", "--part", "minor").status).toBe(1);
    expect(names.map(f.read)).toEqual(before);
  });

  it("bumps all manifests and preserves curated notes", () => {
    const f = fixture();
    expect(f.run("release", "--part", "minor").status).toBe(0);
    expect(f.run("version", "check", "v0.19.0").status).toBe(0);
    expect(f.read("native-helpers/Cargo.toml")).toContain('version = "0.19.0"');
    expect(f.read("native-helpers/Cargo.lock")).toContain('version = "0.19.0"');
    expect(f.read("CHANGELOG.md")).toContain("## [0.19.0] - ");
    expect(f.run("changelog", "notes", "0.19.0").stdout.trim()).toBe("- Fix a reproducible bug.");
  });

  it("rejects a stale Cargo lock version", () => {
    const f = fixture();
    writeFileSync(
      join(f.root, "src-tauri/Cargo.lock"),
      '[[package]]\nname = "tunnelde"\nversion = "0.17.0"\n',
    );
    const result = f.run("version", "check");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Cargo.lock 0.17.0");
  });
});

describe("release publishing", () => {
  function publishingFixture() {
    const f = fixture();
    const manifest = {
      version: "0.19.0",
      platforms: {
        "windows-x86_64": {
          signature: "signature",
          url: "https://github.com/TunneldeDev/Tunnelde/releases/download/v0.19.0/Tunnelde_0.19.0_x64-setup.exe",
        },
      },
    };
    const assets = [
      "latest.json",
      "Tunnelde_0.19.0_aarch64.dmg",
      "Tunnelde_0.19.0_x64.dmg",
      "Tunnelde_0.19.0_x64-setup.exe",
    ].map((name) => ({ name, size: 100 }));
    writeFileSync(join(f.root, "manifest.json"), JSON.stringify(manifest));
    writeFileSync(join(f.root, "assets.json"), JSON.stringify({ assets }));
    const run = (...extra: string[]) =>
      f.run(
        "verify-assets",
        "--tag",
        "v0.19.0",
        "--manifest",
        "manifest.json",
        "--assets",
        "assets.json",
        ...extra,
      );
    return { f, assets, run };
  }

  it("refuses to publish when an updater download or signature is absent", () => {
    const { f, assets, run } = publishingFixture();
    expect(run().status).toBe(1);
    assets.push({ name: "Tunnelde_0.19.0_x64-setup.exe.sig", size: 100 });
    writeFileSync(join(f.root, "assets.json"), JSON.stringify({ assets }));
    expect(run().status).toBe(0);
    assets[3]!.size = 0;
    writeFileSync(join(f.root, "assets.json"), JSON.stringify({ assets }));
    expect(run().status).toBe(1);
  });

  it.each([
    ["tunnelde-agent-windows-x86_64.exe", 100],
    ["tunnelde-agent-macos-aarch64", 100],
    ["tunnelde-agent-macos-x86_64", 100],
    ["tunnelde-agent-linux-x86_64", 100],
    ["tunnelde-agent-linux-aarch64", 100],
    ["tunnelde-agent-linux-aarch64.sha256", 100],
    ["tunnelde-agent-windows-x86_64.exe", 0],
  ])("refuses native helper asset %s of size %s in a desktop release", (name, size) => {
    const { f, assets, run } = publishingFixture();
    assets.push({ name: "Tunnelde_0.19.0_x64-setup.exe.sig", size: 100 }, { name, size });
    writeFileSync(join(f.root, "assets.json"), JSON.stringify({ assets }));
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("native helpers belong in Actions artifacts");
    expect(result.stderr).toContain(name);
  });

  it("rejects the obsolete helper-release flag", () => {
    const { run } = publishingFixture();
    const result = run("--helpers");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("--helpers is no longer supported");
  });

  it("builds helpers as Actions artifacts and gates the desktop release separately", () => {
    const workflow = readFileSync(join(process.cwd(), ".github/workflows/release.yml"), "utf8");
    const helpers = workflow.split("\n  helpers:\n")[1]!.split("\n  updater:\n")[0]!;
    expect(helpers).toContain("cargo test --locked --manifest-path native-helpers/Cargo.toml");
    expect(helpers).toContain(
      "cargo build --release --locked --manifest-path native-helpers/Cargo.toml",
    );
    expect(helpers).toContain("actions/upload-artifact@v4");
    expect(helpers).toContain("if-no-files-found: error");
    expect(helpers).not.toContain("gh release upload");
    expect(workflow).not.toContain("--assets assets.json --helpers");
  });
});
