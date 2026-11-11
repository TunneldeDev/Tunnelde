import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("packaged terminal styles", () => {
  it("allows xterm runtime styles without weakening script restrictions", () => {
    const { security } = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8")).app;
    // A generated style nonce makes Chromium ignore unsafe-inline and blocks
    // xterm's dynamic glyph, ANSI palette, cursor and scrollbar styles.
    expect(security.dangerousDisableAssetCspModification).toEqual(["style-src"]);
    const directives = Object.fromEntries(
      security.csp.split(";").map((directive: string) => {
        const [name, ...values] = directive.trim().split(/\s+/);
        return [name, values];
      }),
    );
    expect(directives["style-src"]).toContain("'unsafe-inline'");
    expect(directives["script-src"]).toEqual([
      "'self'",
      "tunnelde-ui:",
      "http://tunnelde-ui.localhost",
      "'wasm-unsafe-eval'",
    ]);
    expect(directives["script-src"]).not.toContain("blob:");
    expect(directives["script-src"]).not.toContain("https:");
    expect(directives["script-src"]).not.toContain("'unsafe-eval'");
    expect(directives["worker-src"]).toContain("'self'");
    expect(directives["object-src"]).toEqual(["'none'"]);
  });
});
