import { readFileSync } from "node:fs";

const appCss = readFileSync("src/styles/app.css", "utf8");

it("defines the shared code editor font from the appearance tokens", () => {
  const rule = appCss.match(/\.td-code-editor\s*\{([^}]*)\}/s)?.[1];

  expect(rule).toBeDefined();
  expect(rule).toMatch(/font-family:\s*var\(--td-mono\);/);
  expect(rule).toMatch(/font-size:\s*var\(--td-mono-size\);/);
});
