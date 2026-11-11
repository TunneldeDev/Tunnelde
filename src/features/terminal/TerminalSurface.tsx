import { useMemo, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ProviderSurface } from "@/components/layout/ProviderSurface";
import { createPersistentSurface } from "@/lib/extensions/persistentSurface";
import type { TerminalBridge } from "@/lib/extensions/terminal/bridge";

/** The host retains the PTY, renderer and recovery UI; providers compose the live screen. */
export function TerminalSurface({
  bridge,
  visible,
  children,
}: {
  bridge: TerminalBridge | null;
  visible: boolean;
  children: ReactNode;
}) {
  const [surface] = useState(createPersistentSurface);
  const Screen = surface.Mount;
  const terminal = useMemo(
    () => bridge && Object.freeze({ Screen: surface.Mount, ...bridge.api }),
    [bridge, surface],
  );
  return (
    <>
      <ProviderSurface
        target="terminal"
        terminal={terminal ?? undefined}
        visible={visible}
        suspended={!bridge}
        validate={surface.hasMount}
        subscribe={surface.subscribe}
        validationError="plugin.terminal.missingScreen"
      >
        <Screen />
      </ProviderSurface>
      {createPortal(children, surface.container)}
    </>
  );
}
