// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

import type { AuthMethod } from "../api/types";

export const AUTH_LABELS: Record<
  AuthMethod,
  "host.auth.password" | "host.auth.key" | "host.auth.agent" | "host.auth.keyboardInteractive"
> = {
  password: "host.auth.password",
  key: "host.auth.key",
  agent: "host.auth.agent",
  keyboardInteractive: "host.auth.keyboardInteractive",
};

export const AUTH_METHODS: AuthMethod[] = ["password", "key"];
