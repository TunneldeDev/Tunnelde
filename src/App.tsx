import { reportError } from "@/lib/diagnostics";
import { brandMark } from "@/lib/brand";
import { useEffect, useLayoutEffect, useState } from "react";

import { bootstrap } from "@/app/bootstrap";
import { loadStartupFonts } from "@/app/startupFonts";
import { AppShell } from "@/components/layout/AppShell";
import { api, isTauri } from "@/lib/api/ipc";
import { presentError } from "@/lib/api/errors";
import { toast } from "@/store/toasts";
import { useWorkspace } from "@/store/workspace";
import { NodeRuntimeGate } from "@/features/plugins/NodeRuntimeSection";
import { ForwardStartGate } from "@/features/forwarding/start/ForwardStartGate";
import {
  PluginPermissionGate,
  PluginRecoveryPrompt,
} from "@/features/plugins/PluginPermissionGate";

export function App() {
  const [started, setStarted] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void bootstrap()
      .catch((error: unknown) => {
        if (cancelled) return;
        reportError("startup", "bootstrap", error);
        useWorkspace.getState().ensureWelcome();
        toast(presentError(error), "error");
      })
      .then(() => {
        if (!cancelled) setStarted(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useLayoutEffect(() => {
    if (!started || !isTauri()) return;
    let cancelled = false;
    void loadStartupFonts()
      .catch((error: unknown) => {
        reportError("startup", "prepareFonts", error, "warn");
      })
      .then(() => {
        if (cancelled) return;
        // Commit restored layout before exposing the native window. Hidden
        // webviews may suspend requestAnimationFrame, so do not wait for it.
        document.getElementById("root")?.getBoundingClientRect();
        return api.mainWindowReady();
      })
      .catch((error: unknown) => {
        reportError("startup", "presentMainWindow", error);
        toast(presentError(error), "error");
      });
    return () => {
      cancelled = true;
    };
  }, [started]);

  if (!started) {
    return (
      <div className="splash">
        <img src={brandMark} width={56} height={56} alt="" />
      </div>
    );
  }

  return (
    <>
      <AppShell />
      <NodeRuntimeGate />
      <PluginPermissionGate />
      <PluginRecoveryPrompt />
      <ForwardStartGate />
    </>
  );
}
