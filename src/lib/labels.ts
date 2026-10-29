// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

import type { AuthMethod, TabKind } from "./types";

export const AUTH_LABELS: Record<
  AuthMethod,
  "host.auth.password" | "host.auth.key" | "host.auth.agent" | "host.auth.keyboardInteractive"
> = {
  password: "host.auth.password",
  key: "host.auth.key",
  agent: "host.auth.agent",
  keyboardInteractive: "host.auth.keyboardInteractive",
};

export const AUTH_METHODS: AuthMethod[] = ["password", "key", "agent", "keyboardInteractive"];

export const TAB_NAV_LABELS: Record<
  Exclude<TabKind, "host" | "terminal">,
  "nav.welcome" | "nav.settings" | "nav.about" | "nav.updates"
> = {
  welcome: "nav.welcome",
  settings: "nav.settings",
  about: "nav.about",
  updates: "nav.updates",
};
