import { afterEach, describe, expect, it } from "vitest";
import i18n from "@/i18n/i18n";
import { pluginFailure } from "@/lib/plugins/errors";

afterEach(async () => {
  await i18n.changeLanguage("en-US");
});

describe.each(["en-US", "zh-CN"])("plugin startup errors in %s", (language) => {
  it("explains exact version requirements and supports errors from older hosts", async () => {
    await i18n.changeLanguage(language);
    const details = { pluginVersion: "1.8.1", hostVersion: "0.32.0-beta.6", required: ">=0.33.0" };
    const message = pluginFailure({
      code: "validation",
      message: "plugin.engine.unsupported",
      details,
    });
    for (const value of Object.values(details)) expect(message).toContain(value);
    expect(message).not.toContain("plugin.engine.unsupported");
    expect(pluginFailure(new Error("plugin.engine.unsupported"))).toBe(
      i18n.t("pluginErrors.hostVersionUnsupported"),
    );
    expect(
      pluginFailure({
        code: "validation",
        message: "plugin.engine.unsupported",
        details: { hostVersion: 42 },
      }),
    ).toBe(i18n.t("pluginErrors.hostVersionUnsupported"));
  });
  it("localizes keys carried by both IPC rejections and plugin status", async () => {
    await i18n.changeLanguage(language);
    for (const message of [
      "node.required",
      "node.incompatible",
      "plugin.api.invalidStorage",
      "plugin.api.busy",
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
