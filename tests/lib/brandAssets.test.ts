import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const text = (path: string) => readFileSync(path, "utf8");

describe("canonical brand assets", () => {
  it("keeps every configured native icon and installer image in assets/brand", () => {
    const config = JSON.parse(text("src-tauri/tauri.conf.json"));
    const nsis = config.bundle.windows.nsis;
    const paths: string[] = [
      ...config.bundle.icon,
      nsis.installerIcon,
      nsis.headerImage,
      nsis.sidebarImage,
    ];
    for (const path of paths) {
      expect(path).toMatch(/^\.\.\/assets\/brand\//);
      expect(existsSync(resolve("src-tauri", path)), path).toBe(true);
    }
  });

  it("shares the renderer mark and colored tray icon without duplicate binaries", () => {
    expect(text("src/lib/brand.ts")).toContain("../../assets/brand/mark-256.png");
    expect(text("index.html")).toContain("/assets/brand/favicon.png");
    const tray = text("src-tauri/src/platform/tray.rs");
    expect(tray).toContain("../../../assets/brand/32x32.png");
    expect(tray).toContain("../../../assets/brand/trayTemplate@2x.png");
    const hashes = readdirSync("assets/brand")
      .filter((name) => /\.(png|bmp|ico|icns)$/.test(name))
      .map((name) =>
        createHash("sha256")
          .update(readFileSync(`assets/brand/${name}`))
          .digest("hex"),
      );
    expect(new Set(hashes).size).toBe(hashes.length);
  });

  it("does not ship a legacy marketplace catalogue", () => {
    expect(existsSync("marketplace/index.json")).toBe(false);
    expect(existsSync("marketplace/README.md")).toBe(false);
  });
});
