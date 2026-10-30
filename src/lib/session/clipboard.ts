// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

import i18n from "@/i18n/i18n";
import { toast } from "@/store/toasts";

/** Writes text to the system clipboard and reports the outcome. */
export function copyText(value: string): void {
  void navigator.clipboard.writeText(value).then(
    () => toast(i18n.t("menu.copied"), "success"),
    () => toast(i18n.t("menu.copyFailed"), "error"),
  );
}
