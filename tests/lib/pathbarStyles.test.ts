import { readFileSync } from "node:fs";

const workbenchCss = readFileSync("src/styles/workbench.css", "utf8");

it("centers the pathbar history trigger without changing shared menu geometry", () => {
  const rule = workbenchCss.match(
    /\.sftp-path__history-trigger\.td-menu__trigger\s*\{([^}]*)\}/s,
  )?.[1];
  expect(rule).toBeDefined();
  expect(rule).toMatch(/align-self:\s*center;/);
  expect(rule).toMatch(/height:\s*24px;/);
  expect(rule).toMatch(/flex:\s*0 0 24px;/);
  expect(workbenchCss).not.toMatch(/(?:^|\n)\.td-menu__trigger\s*\{/);
});
