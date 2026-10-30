// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

import { ArrowUpCircle } from "lucide-react";

import { useUpdates } from "@/store/updates";
import { useWorkspace } from "@/store/workspace";

/** Shown in the status bar while a newer release is waiting. */
export function UpdatePill() {
  const state = useUpdates((value) => value.state);
  const openPage = useWorkspace((value) => value.openPage);

  if (!state?.available || state.skipped || !state.version) {
    return null;
  }

  return (
    <button type="button" className="td-update-pill" onClick={() => openPage("updates")}>
      <ArrowUpCircle size={12} />
      <span>{state.version}</span>
    </button>
  );
}
