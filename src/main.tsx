import "@xterm/xterm/css/xterm.css";
import "@fontsource/fira-code/latin-400.css";
import "@fontsource/fira-code/latin-500.css";
import "@fontsource/jetbrains-mono/latin-400.css";
import "@fontsource/jetbrains-mono/latin-500.css";
import "@fontsource/ibm-plex-mono/latin-400.css";
import "@fontsource/ibm-plex-mono/latin-500.css";
import "@fontsource/ibm-plex-sans/latin-400.css";
import "@fontsource/ibm-plex-sans/latin-500.css";
import "@fontsource/ibm-plex-sans/latin-600.css";
import "@/styles/tokens.css";
import "@/styles/base.css";
import "@/styles/app.css";
import "@/styles/workbench.css";
import "@/styles/plugins.css";
import "@/styles/settings.css";
import "@/styles/colors.css";
import "@/styles/corners.css";

import { lazy, StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";

import "@/i18n/i18n";
import { installGlobalErrorDiagnostics } from "@/lib/diagnostics";

installGlobalErrorDiagnostics();

const container = document.getElementById("root");
if (!container) {
  throw new Error("root container is missing");
}

// Do not even evaluate the main bootstrap module in a satellite document.
const Entry = lazy(() =>
  new URLSearchParams(window.location.search).get("panelWindow") === "1"
    ? import("@/app/SatelliteApp").then(({ SatelliteApp }) => ({ default: SatelliteApp }))
    : import("@/App").then(({ App }) => ({ default: App })),
);
createRoot(container).render(
  <StrictMode>
    <Suspense fallback={<div className="splash" role="status" />}>
      <Entry />
    </Suspense>
  </StrictMode>,
);
