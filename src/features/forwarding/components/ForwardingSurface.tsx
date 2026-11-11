import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ProviderSurface } from "@/components/layout/ProviderSurface";
import { createPersistentSurface } from "@/lib/extensions/persistentSurface";
import { createForwardingContext } from "@/lib/extensions/forwarding/context";
import type { ForwardingController } from "../runtime/useForwardingController";

/** Presentation may omit rows; the host controller and editor remain mounted. */
export function ForwardingSurface({
  hostId,
  title,
  controller,
  children,
}: {
  hostId: string;
  title: string;
  controller: ForwardingController;
  children: ReactNode;
}) {
  const [surface] = useState(createPersistentSurface);
  const Entries = surface.Mount;
  const { rules, session, busy, loading, form, failure } = controller;
  const rows = useMemo(
    () =>
      rules.map((rule) => ({
        ...rule,
        runtimeId: rule.runtimeId ?? null,
        active: controller.isActive(rule),
      })),
    // Sessions determine whether the registered listener is still usable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rules, controller.sessions],
  );
  const frame = useMemo(
    () => ({
      hostId,
      title,
      revision: crypto.randomUUID(),
      total: rows.length,
      connected: !!session,
      busy: busy || loading,
      editing: !!form,
      error: failure?.message ?? null,
    }),
    [hostId, title, rows, session, busy, loading, form, failure?.message],
  );
  const current = useRef<{ frame: object; controller: ForwardingController } | null>(null);
  useLayoutEffect(() => {
    current.current = { frame, controller };
    return () => {
      current.current = null;
    };
  }, [frame, controller]);
  /* eslint-disable react-hooks/refs -- Factories retain callbacks; they do not invoke them during render. */
  const context = useMemo(
    () =>
      Object.freeze({
        Entries,
        ...createForwardingContext(
          frame,
          rows,
          () => {
            if (current.current?.frame !== frame) throw new Error("plugin.forwarding.changed");
          },
          {
            validate: () => current.current!.controller.validate(),
            refresh: () => current.current!.controller.refresh(),
            start: (entries, authority) =>
              current.current!.controller.startTargets(entries, authority),
            stop: (entry, authority) => {
              void current.current!.controller.stop(entry, authority);
            },
            requestAdd: (authority) => current.current!.controller.add(authority),
            requestEdit: (entry, authority) => current.current!.controller.edit(entry, authority),
            requestRemove: (entry, authority) =>
              current.current!.controller.requestRemove(entry, authority),
            requestDisconnect: (authority) =>
              current.current!.controller.requestDisconnect(authority),
          },
        ),
      }),
    [Entries, frame, rows],
  );
  /* eslint-enable react-hooks/refs */
  return (
    <>
      <div hidden={!!form}>
        <ProviderSurface target="forwarding" forwarding={context} visible={!form}>
          <Entries />
        </ProviderSurface>
      </div>
      {createPortal(children, surface.container)}
    </>
  );
}
