import { afterEach, describe, expect, it } from "vitest";
import i18n from "@/i18n/i18n";
import { translateError } from "@/lib/api/errors";

afterEach(async () => {
  await i18n.changeLanguage("en-US");
});

const failure = (
  statusCode: number | null,
  serverMessage: string | null,
  reason = "Failure: Failure",
) => ({
  code: "ssh",
  message: "Remote move/rename failed",
  details: {
    operation: "rename",
    from: "/源/a.json",
    to: "/挂载/a.json",
    statusCode,
    serverMessage,
    reason,
  },
});

describe.each(["zh-CN", "en-US"])("remote file errors in %s", (language) => {
  it("explains unspecified SFTP failures and retains both paths without inventing a diagnosis", async () => {
    await i18n.changeLanguage(language);
    for (const message of ["Failure", "", " failure ", "Failure: Failure"]) {
      const text = translateError(failure(4, message));
      expect(text).toContain("/源/a.json");
      expect(text).toContain("/挂载/a.json");
      expect(text).toContain("SFTP 4");
      expect(text).toContain(i18n.t("sftp.renameServerFailure"));
      expect(text).not.toContain("Failure: Failure");
    }
  });

  it("keeps a specific server explanation and distinguishes transport failures", async () => {
    await i18n.changeLanguage(language);
    for (const [code, message] of [
      [4, "Invalid cross-device link"],
      [3, "Permission denied"],
      [2, "No such file"],
    ] as const) {
      const text = translateError(failure(code, message));
      expect(text).toContain(message);
      expect(text).toContain(`SFTP ${code}`);
      expect(text).not.toContain(i18n.t("sftp.renameServerFailure"));
    }
    expect(translateError(failure(null, null, "Timeout"))).toContain("Timeout");
    const preparation = translateError(failure(null, null, "sftp.error: Failure: Failure"));
    expect(preparation).toContain("/源/a.json");
    expect(preparation).toContain("/挂载/a.json");
    expect(preparation).toContain(i18n.t("sftp.serverUnspecifiedFailure"));
    expect(preparation).not.toContain("Failure: Failure");
    expect(translateError({ code: "ssh", message: "sftp.error: Failure: Failure" })).toBe(
      i18n.t("sftp.serverUnspecifiedFailure"),
    );
    expect(
      translateError({ code: "ssh", message: "sftp.error: Failure: Disk quota exceeded" }),
    ).toBe("Failure: Disk quota exceeded");
    expect(translateError({ code: "ssh", message: "sftp.channel: Connection lost" })).toBe(
      "Connection lost",
    );
    expect(translateError({ code: "ssh", message: "sftp.error: Timeout" })).toBe("Timeout");
    expect(
      translateError({
        code: "ssh",
        message: "sftp.error: Remote move/rename failed (/source -> /target): Failure: Failure",
      }),
    ).toBe("Remote move/rename failed (/source -> /target): Failure: Failure");
  });

  it("tolerates incomplete diagnostic metadata from other host versions", async () => {
    await i18n.changeLanguage(language);
    expect(
      translateError({
        code: "ssh",
        message: "sftp.error: Failure: Failure",
        details: { operation: "rename", from: 42 },
      }),
    ).toBe(i18n.t("sftp.serverUnspecifiedFailure"));
    expect(
      translateError({ code: "ssh", message: "sftp.error: Permission denied: Permission denied" }),
    ).toContain("Permission denied");
  });
});
