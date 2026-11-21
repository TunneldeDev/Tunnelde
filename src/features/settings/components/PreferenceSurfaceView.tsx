import {
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type ComponentType,
} from "react";
import { createPortal } from "react-dom";
import { createPersistentSurface } from "@/lib/extensions/persistentSurface";
import type { FrontendPreferenceField } from "@/lib/extensions/contracts/preferences/provider";
import type { Settings } from "@/lib/api/types";
import type { PreferencesContext } from "@/lib/extensions/preferences/context";
import type { FrontendPreferences } from "@/lib/extensions/contracts/preferences/provider";

export interface PreferenceSurfaceServices {
  useData(): { settings: Settings; busy: boolean; error: string | null };
  isCurrent(settings: Settings): boolean;
  Provider: ComponentType<{
    context: PreferencesContext & Pick<FrontendPreferences, "Fields">;
    visible: boolean;
    children: ReactNode;
  }>;
}

export function PreferenceSurfaceView({
  children,
  services,
  section,
  query,
  modifiedOnly,
  fields,
  visible,
}: {
  children: ReactNode;
  services: PreferenceSurfaceServices;
  section: string;
  query: string;
  modifiedOnly: boolean;
  fields: readonly FrontendPreferenceField[];
  visible: boolean;
}) {
  const [surface] = useState(createPersistentSurface);
  const { settings, busy, error } = services.useData();
  const Fields = surface.Mount;
  const Provider = services.Provider;
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
      services.isCurrent(frame.settings) &&
      committed.current === frame &&
      (!mutation || active.current),
  };
  return (
    <>
      <Provider context={context} visible={visible}>
        <Fields />
      </Provider>
      {createPortal(children, surface.container)}
    </>
  );
}
