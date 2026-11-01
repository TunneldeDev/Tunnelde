// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

import { KnownHostsList } from "@/features/settings/KnownHostsList";

/** The same trust-management actions are available in the compact side view. */
export function TrustedHostsSidebar({ active }: { active: boolean }) {
  return <KnownHostsList active={active} variant="sidebar" />;
}
