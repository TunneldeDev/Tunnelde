import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ProviderSurface } from "@/components/layout/ProviderSurface";
import { createPersistentSurface } from "@/lib/extensions/persistentSurface";
import type { FilePreviewContext } from "@/lib/extensions/files/preview/context";
import { mountFilePreview } from "@/lib/files/preview/registry";

/** The host renderer stays mounted when its public presentation changes. */
export function PreviewSurface({
  context,
  children,
}: {
  context: FilePreviewContext;
  children: ReactNode;
}) {
  const [surface] = useState(createPersistentSurface);
  const registration = useRef<ReturnType<typeof mountFilePreview> | null>(null);
  const id = context.snapshot.id;
  useLayoutEffect(() => {
    const mounted = mountFilePreview(id);
    registration.current = mounted;
    return () => {
      mounted.dispose();
      if (registration.current === mounted) registration.current = null;
    };
  }, [id]);
  useLayoutEffect(() => {
    registration.current?.publish(context);
  }, [context]);
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
