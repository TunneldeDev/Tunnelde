import { useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ProviderSurface } from "@/components/layout/ProviderSurface";
import { createPersistentSurface } from "@/lib/extensions/persistentSurface";
import type { FilePreviewContext } from "@/lib/extensions/files/preview/context";

/** The host renderer stays mounted when its public presentation changes. */
export function PreviewSurface({
  context,
  children,
}: {
  context: FilePreviewContext;
  children: ReactNode;
}) {
  const [surface] = useState(createPersistentSurface);
  const Body = surface.Mount;
  return (
    <>
      <ProviderSurface target="filePreview" filePreview={{ ...context, Body }}>
        <Body />
      </ProviderSurface>
      {createPortal(children, surface.container)}
    </>
  );
}
