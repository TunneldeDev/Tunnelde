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

import { lazy, StrictMode, Suspense, useEffect } from "react";
import { createRoot } from "react-dom/client";

import "@/i18n/i18n";
import { DiagnosticNotice } from "@/components/ui/overlay/DiagnosticNotice";
import { PanelViewBoundary } from "@/lib/panels/viewBoundary";
import {
  installGlobalErrorDiagnostics,
  reportError,
  type DiagnosticEvent,
} from "@/lib/diagnostics";

installGlobalErrorDiagnostics();

const container = document.getElementById("root");
if (!container) {
  throw new Error("root container is missing");
}

// Do not even evaluate the main bootstrap module in a satellite document.
const satellite = new URLSearchParams(window.location.search).get("panelWindow") === "1";
const Entry = lazy(() =>
  satellite
    ? import("@/app/SatelliteApp").then(({ SatelliteApp }) => ({ default: SatelliteApp }))
    : import("@/App").then(({ App }) => ({ default: App })),
);
function RootFailure({ event }: { event: DiagnosticEvent | null }) {
  useEffect(() => {
    if (!event || satellite || !("__TAURI_INTERNALS__" in window)) return;
    // Bootstrap never reached the normally responsible layout effect. Let the
    // existing main-only readiness command expose this recovery screen.
    void import("@/lib/api/ipc")
      .then(({ api }) => api.mainWindowReady())
      .catch((error) => reportError("startup", "presentFailure", error));
  }, [event]);
  return <DiagnosticNotice event={event} retry={() => window.location.reload()} />;
}

createRoot(container, {
  onCaughtError: (error, info) => {
    // Product boundaries report after commit and attach the resulting event ID.
    if (!(info.errorBoundary instanceof PanelViewBoundary)) {
      reportError("runtime", "react.caught", error, "error", {
        componentStack: info.componentStack ?? undefined,
      });
    }
  },
  onUncaughtError: (error, info) => {
    reportError("runtime", "react.uncaught", error, "error", {
      componentStack: info.componentStack ?? undefined,
    });
  },
}).render(
  <StrictMode>
    <PanelViewBoundary
      domain="runtime"
      operation="renderRoot"
      fallback={(event) => <RootFailure event={event} />}
    >
      <Suspense fallback={<div className="splash" role="status" />}>
        <Entry />
      </Suspense>
    </PanelViewBoundary>
  </StrictMode>,
);
