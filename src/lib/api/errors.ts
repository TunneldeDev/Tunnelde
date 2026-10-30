// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

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
    if (error.message.startsWith("ssh.error:")) {
      return error.message.slice("ssh.error:".length).trim();
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
    return error.message;
  }
  return translate("error.generic");
}
