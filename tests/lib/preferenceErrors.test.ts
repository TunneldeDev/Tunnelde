import { afterEach, describe, expect, it } from "vitest";
import i18n from "@/i18n/i18n";
import { translateError } from "@/lib/api/errors";

afterEach(async () => {
  await i18n.changeLanguage("en-US");
});

describe.each(["en-US", "zh-CN"])("preference diagnostics in %s", (language) => {
  it("keeps the public field path and explains stale revisions", async () => {
    await i18n.changeLanguage(language);
    expect(
      translateError({
        code: "validation",
        message: "preferences.invalidValue:terminal.lineHeight",
      }),
    ).toBe(i18n.t("preferences.invalidValue", { field: "terminal.lineHeight" }));
    expect(translateError({ code: "validation", message: "preferences.staleRevision" })).toBe(
      i18n.t("preferences.staleRevision"),
    );
  });
});
