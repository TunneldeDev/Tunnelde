import { afterEach, describe, expect, it } from "vitest";
import i18n from "@/i18n/i18n";
import { pluginFailure } from "@/lib/plugins/errors";

afterEach(async () => {
  await i18n.changeLanguage("en-US");
});

describe.each(["en-US", "zh-CN"])("plugin startup errors in %s", (language) => {
  it("localizes keys carried by both IPC rejections and plugin status", async () => {
    await i18n.changeLanguage(language);
    for (const message of [
      "node.required",
      "node.incompatible",
      "plugin.api.invalidStorage",
    ] as const) {
      expect(pluginFailure(new Error(message))).toBe(i18n.t(message));
      expect(pluginFailure({ code: "validation", message })).toBe(i18n.t(message));
      expect(pluginFailure(new Error(`plugin.error: ${message}`))).toBe(i18n.t(message));
    }
  });

  it("preserves specific failures rather than replacing them with field validation", async () => {
    await i18n.changeLanguage(language);
    expect(pluginFailure({ code: "validation", message: "plugin.spawn: executable missing" })).toBe(
      `${i18n.t("pluginErrors.spawn")}: executable missing`,
    );
    expect(pluginFailure(new Error("plugin.error: Invalid saved configuration"))).toBe(
      "Invalid saved configuration",
    );
    expect(pluginFailure(new Error("plugin.error: plugin exited"))).toBe(
      i18n.t("pluginErrors.exited"),
    );
    expect(pluginFailure(new Error("plugin.timeout"))).toBe(i18n.t("pluginErrors.timeout"));
  });
});
