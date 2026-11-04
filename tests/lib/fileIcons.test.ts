import { expect, it } from "vitest";
import type { PluginFileIconTheme, PluginInfo } from "@/lib/api/types";
import { createFileIconResolver, installedIconThemes } from "@/lib/files/icons";

const theme: PluginFileIconTheme = {
  id: "common",
  name: "Common files",
  icons: {
    code: { symbol: "code", color: "#3178c6", label: "TS" },
    archive: { symbol: "archive" },
    text: { symbol: "text" },
  },
  extensions: { ts: "code", "tar.gz": "archive", gz: "text" },
  fileNames: { Dockerfile: "code", ".gitignore": "text", "config.ts": "text" },
};

it("matches exact names before longest compound extensions without inspecting file contents", () => {
  const resolve = createFileIconResolver(theme);
  expect(resolve("file.TS")).toBe(theme.icons.code);
  expect(resolve("/var/backups/project.TAR.GZ")).toBe(theme.icons.archive);
  expect(resolve("C:\\project\\Dockerfile")).toBe(theme.icons.code);
  expect(resolve(".gitignore")).toBe(theme.icons.text);
  expect(resolve("config.ts")).toBe(theme.icons.text);
  expect(resolve(".ts")).toBeUndefined();
  expect(resolve("notes")).toBeUndefined();
  expect(resolve("fake.ts.exe")).toBeUndefined();
});

it("supports explicit fallback icons and deterministic theme ordering", () => {
  const plugins = [
    { id: "z", name: "Z", fileIconThemes: [theme] },
    { id: "a", name: "A", fileIconThemes: [theme] },
  ] as PluginInfo[];
  expect(installedIconThemes(plugins).map((item) => item.id)).toEqual(["a:common", "z:common"]);
  expect(createFileIconResolver({ ...theme, defaultIcon: "text" })("unknown")).toBe(
    theme.icons.text,
  );
  expect(createFileIconResolver()("file.ts")).toBeUndefined();
});
