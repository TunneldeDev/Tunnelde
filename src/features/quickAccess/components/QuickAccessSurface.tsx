import { useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ProviderSurface } from "@/components/layout/ProviderSurface";
import { createPersistentSurface } from "@/lib/extensions/persistentSurface";
import { createQuickAccessContext } from "@/lib/extensions/search/quickAccess/context";
import type { QuickAccessController } from "../runtime/useController";

export function QuickAccessSurface({
  manager,
  children,
}: {
  manager: QuickAccessController;
  children: ReactNode;
}) {
  const [surface] = useState(createPersistentSurface);
  const Entries = surface.Mount;
  return (
    <>
      <ProviderSurface
        target="quickAccess"
        quickAccess={{ Entries, ...createQuickAccessContext(manager) }}
      >
        <Entries />
      </ProviderSurface>
      {createPortal(children, surface.container)}
    </>
  );
}
