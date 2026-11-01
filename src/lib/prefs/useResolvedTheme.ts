import { useSyncExternalStore } from "react";
import type { ThemeMode } from "@/lib/api/types";
import { prefersLightScheme, resolveTheme } from "./appearance";

function subscribe(onChange: () => void) {
  const query = window.matchMedia?.("(prefers-color-scheme: light)");
  if (!query) return () => {};
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

/** Keeps theme-dependent controls current while the settings page stays open. */
export function useResolvedTheme(mode: ThemeMode) {
  return resolveTheme(
    mode,
    useSyncExternalStore(subscribe, prefersLightScheme, () => false),
  );
}
