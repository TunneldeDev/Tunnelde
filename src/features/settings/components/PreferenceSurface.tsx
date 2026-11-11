import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ProviderSurface } from "@/components/layout/ProviderSurface";
import { createPersistentSurface } from "@/lib/extensions/persistentSurface";
import type { FrontendPreferenceField } from "@/lib/extensions/contracts/preferences/provider";
import { useSettings } from "@/store/settings";

export function PreferenceSurface({
  children,
  section,
  query,
  modifiedOnly,
  fields,
  visible,
}: {
  children: ReactNode;
  section: string;
  query: string;
  modifiedOnly: boolean;
  fields: readonly FrontendPreferenceField[];
  visible: boolean;
}) {
  const [surface] = useState(createPersistentSurface);
  const settings = useSettings((state) => state.settings);
  const busy = useSettings((state) => state.saving);
  const error = useSettings((state) => state.error);
  const Fields = surface.Mount;
  const fieldsKey = JSON.stringify(fields);
  const frame = useMemo(
    () => ({
      settings,
      snapshot: Object.freeze({
        revision: crypto.randomUUID(),
        section,
        query,
        modifiedOnly,
        fields: Object.freeze(
          (JSON.parse(fieldsKey) as FrontendPreferenceField[]).map((field) => Object.freeze(field)),
        ),
        busy,
        error,
      }),
    }),
    [section, query, modifiedOnly, fieldsKey, settings, busy, error],
  );
  const committed = useRef<object | null>(null);
  const active = useRef(visible);
  useLayoutEffect(() => {
    committed.current = frame;
    active.current = visible;
    return () => {
      committed.current = null;
      active.current = false;
    };
  }, [frame, visible]);
  // Only the factories capture refs during render. Provider calls happen later.
  const context = {
    Fields,
    snapshot: frame.snapshot,
    validate: (mutation: boolean) =>
      useSettings.getState().settings === frame.settings &&
      committed.current === frame &&
      (!mutation || active.current),
  };
  return (
    <>
      <ProviderSurface target="preferences" preferences={context} visible={visible}>
        <Fields />
      </ProviderSurface>
      {createPortal(children, surface.container)}
    </>
  );
}
