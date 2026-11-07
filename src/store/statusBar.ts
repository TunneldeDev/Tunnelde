import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import { nativeEvents } from "@/lib/events/native";
import { createSubscriptionGroup } from "@/lib/events/bus";
import type { StatusBarSnapshot } from "@/lib/plugins/statusBar";

export const useStatusBarContributions = create<StatusBarSnapshot>(() => ({
  revision: -1,
  items: [],
}));

/** Subscribe before reading: event loss and a recreated WebView cannot leave ghosts. */
export async function wireStatusBarContributions(signal: AbortSignal): Promise<() => void> {
  let request = 0;
  let disposed = false;
  const accept = (snapshot: StatusBarSnapshot) => {
    if (
      !disposed &&
      !signal.aborted &&
      snapshot.revision >= useStatusBarContributions.getState().revision
    )
      useStatusBarContributions.setState(snapshot);
  };
  const refresh = async () => {
    const current = ++request;
    try {
      const snapshot = await invoke<StatusBarSnapshot>("plugin_status_bar_snapshot");
      if (current === request) accept(snapshot);
    } catch (error) {
      if (!signal.aborted) console.error("Could not synchronize status bar contributions", error);
    }
  };
  const group = createSubscriptionGroup([
    (lifetime) =>
      nativeEvents.on(
        "plugin://status-bar-changed",
        (snapshot) => {
          ++request;
          accept(snapshot);
        },
        lifetime,
      ),
    (lifetime) =>
      nativeEvents.on(
        "plugin:security-changed",
        () => {
          useStatusBarContributions.setState({ items: [] });
          void refresh();
        },
        lifetime,
      ),
    (lifetime) =>
      nativeEvents.on(
        "plugin://state",
        () => {
          void refresh();
        },
        lifetime,
      ),
    (lifetime) =>
      nativeEvents.on(
        "ui://resume",
        () => {
          void refresh();
        },
        lifetime,
      ),
  ]);
  const dispose = () => {
    disposed = true;
    ++request;
    group.dispose();
  };
  signal.addEventListener("abort", dispose, { once: true });
  try {
    if (!signal.aborted) {
      await group.start();
      await refresh();
    }
  } catch (error) {
    dispose();
    if (!signal.aborted) throw error;
  }
  return () => {
    signal.removeEventListener("abort", dispose);
    dispose();
  };
}
