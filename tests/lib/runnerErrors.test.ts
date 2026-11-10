import { afterEach, describe, expect, it } from "vitest";
import i18n from "@/i18n/i18n";
import { translateError } from "@/lib/api/errors";

afterEach(async () => {
  await i18n.changeLanguage("en-US");
});

describe.each(["en-US", "zh-CN"])("runner command errors in %s", (language) => {
  it("preserves remote stderr, including multiline messages and colons, from IPC", async () => {
    await i18n.changeLanguage(language);
    const reason = "helper: permission denied\nCannot read /home/qa/task: access denied";
    const message = translateError({
      code: "validation",
      message: `plugin.runners.commandFailed:  ${reason}\n`,
    });
    expect(message).toBe(i18n.t("plugin.runners.commandFailed", { reason }));
    expect(message).toContain(reason);
    expect(message).not.toContain("plugin.runners.commandFailed");
    expect(message).not.toBe(i18n.t("error.validation"));
  });

  it("explains where to find diagnostics when stderr is empty", async () => {
    await i18n.changeLanguage(language);
    const reason = i18n.t("plugin.runners.noCommandDetails");
    const expected = i18n.t("plugin.runners.commandFailed", { reason });
    for (const output of ["", " \r\n\t"]) {
      expect(
        translateError({ code: "validation", message: `plugin.runners.commandFailed:${output}` }),
      ).toBe(expected);
    }
    expect(expected).toContain(reason);
    expect(expected).not.toContain("plugin.runners.");
  });
});
