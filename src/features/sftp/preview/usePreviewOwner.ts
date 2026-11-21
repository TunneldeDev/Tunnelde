import { useLayoutEffect, useRef } from "react";
import { mountFilePreview } from "@/lib/files/preview/registry";
import { previewOwners, type PreviewOwner } from "./owner";

/** Register ABOVE PreviewFrame/NativePanelView, not inside a movable renderer.
 * StrictMode cleanup or an old owner cannot withdraw its replacement. */
export function usePreviewOwner(owner: PreviewOwner) {
  const mounted = useRef<{
    public: ReturnType<typeof mountFilePreview>;
    private: ReturnType<typeof previewOwners.mount>;
  } | null>(null);
  const id = owner.context.snapshot.id;
  useLayoutEffect(() => {
    const registration = { public: mountFilePreview(id), private: previewOwners.mount() };
    mounted.current = registration;
    return () => {
      registration.private.dispose();
      registration.public.dispose();
      if (mounted.current === registration) mounted.current = null;
    };
  }, [id]);
  useLayoutEffect(() => {
    mounted.current?.public.publish(owner.context);
    mounted.current?.private.publish(owner);
  });
}
