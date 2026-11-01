import { useEffect } from "react";

import { bootstrap } from "@/app/bootstrap";
import { AppShell } from "@/components/layout/AppShell";
import { useSettings } from "@/store/settings";
import { NodeRuntimeGate } from "@/features/plugins/NodeRuntimeSection";
import {
  PluginPermissionGate,
  PluginRecoveryPrompt,
} from "@/features/plugins/PluginPermissionGate";

export function App() {
  const ready = useSettings((state) => state.ready);

  useEffect(() => {
    void bootstrap();
  }, []);

  if (!ready) {
    return (
      <div className="splash">
        <img src="/brand/mark-256.png" width={56} height={56} alt="" />
      </div>
    );
  }

  return (
    <>
      <AppShell />
      <NodeRuntimeGate />
      <PluginPermissionGate />
      <PluginRecoveryPrompt />
    </>
  );
}
