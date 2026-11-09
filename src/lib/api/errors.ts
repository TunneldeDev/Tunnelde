import i18n from "@/i18n/i18n";
import { isIpcError } from "@/lib/api/types";

const CODE_KEYS: Record<string, string> = {
  validation: "error.validation",
  notFound: "error.notFound",
  database: "error.database",
  update: "error.update",
  io: "error.io",
  internal: "error.internal",
  ssh: "error.ssh",
};

type Translate = (key: string, options?: Record<string, unknown>) => string;
const translate = i18n.t.bind(i18n) as unknown as Translate;

function translateKey(key: string): string | null {
  if (i18n.exists(key)) {
    return translate(key);
  }
  return null;
}

export function translateError(error: unknown): string {
  if (isIpcError(error)) {
    if (
      error.message === "plugin.frontend.sdkUnsupported" &&
      typeof error.details?.required === "string" &&
      typeof error.details.available === "string"
    ) {
      return translate("plugin.frontend.sdkUnsupportedDetails", error.details);
    }
    if (error.code === "ssh" && error.details?.operation === "rename") {
      const details = error.details;
      if (["from", "to", "reason"].every((key) => typeof details[key] === "string")) {
        const serverMessage =
          typeof details.serverMessage === "string" ? details.serverMessage.trim() : "";
        const unspecified =
          details.statusCode === 4 &&
          (!serverMessage || /^failure(?::\s*failure)?$/i.test(serverMessage));
        const reason = unspecified
          ? translate("sftp.renameServerFailure")
          : typeof details.statusCode === "number" && serverMessage
            ? translate("sftp.renameStatusReason", {
                statusCode: details.statusCode,
                reason: serverMessage,
              })
            : String(details.reason).startsWith("sftp.")
              ? translateError({ code: "ssh", message: String(details.reason) })
              : String(details.reason);
        return translate("sftp.renameFailed", { from: details.from, to: details.to, reason });
      }
    }
    if (error.message === "plugin.engine.unsupported") {
      const details = error.details;
      if (
        details &&
        ["hostVersion", "pluginVersion", "required"].every(
          (key) => typeof details[key] === "string",
        )
      ) {
        return translate("pluginErrors.hostVersionMismatch", {
          hostVersion: details.hostVersion,
          pluginVersion: details.pluginVersion,
          required: details.required,
        });
      }
      return translate("pluginErrors.hostVersionUnsupported");
    }
    if (error.message.startsWith("ssh.error:")) {
      return error.message.slice("ssh.error:".length).trim();
    }
    // SFTP wraps transport/protocol details; do not reduce every failure to
    // "SSH error", which prevents users from distinguishing reconnection,
    // permission and server failures.
    if (/^sftp\.(error|channel|subsystem):/.test(error.message)) {
      const detail = error.message.slice(error.message.indexOf(":") + 1).trim();
      if (/^sftp\.error:/.test(error.message) && /^failure:\s*failure$/i.test(detail))
        return translate("sftp.serverUnspecifiedFailure");
      return detail || translate("error.ssh");
    }
    const known = translateKey(error.message);
    if (known) {
      return known;
    }
    const codeKey = CODE_KEYS[error.code];
    if (codeKey) {
      return translate(codeKey);
    }
    return error.message;
  }
  if (error instanceof Error) {
    return translateKey(error.message) ?? error.message;
  }
  return translate("error.generic");
}
