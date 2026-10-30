// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

import "@xterm/xterm/css/xterm.css";
import "@fontsource/ibm-plex-mono/latin-400.css";
import "@fontsource/ibm-plex-mono/latin-500.css";
import "@fontsource/ibm-plex-sans/latin-400.css";
import "@fontsource/ibm-plex-sans/latin-500.css";
import "@fontsource/ibm-plex-sans/latin-600.css";
import "@/styles/tokens.css";
import "@/styles/base.css";
import "@/styles/app.css";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "@/App";
import "@/i18n/i18n";

const container = document.getElementById("root");
if (!container) {
  throw new Error("root container is missing");
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
