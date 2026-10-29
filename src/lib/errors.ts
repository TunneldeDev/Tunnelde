// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

import i18n from "@/i18n/i18n";
import { isIpcError } from "@/lib/types";

const CODE_KEYS: Record<string, string> = {
  validation: "error.validation",
  notFound: "error.notFound",
  database: "error.database",
  update: "error.update",
  io: "error.io",
  internal: "error.internal",
};

export function translateError(error: unknown): string {
  if (isIpcError(error)) {
    const key = CODE_KEYS[error.code];
    if (key) {
      return i18n.t(key as never);
    }
    return error.message;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return i18n.t("error.generic");
}
