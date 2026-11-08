import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { useLayoutEffect, type ReactNode } from "react";
import { createSubscriptionGroup } from "@/lib/events/bus";
import { nativeEvents } from "@/lib/events/native";
import type { TabBarSnapshot } from "@/lib/plugins/tabBar";

interface LocalContribution {
  tabId: string;
  id: string;
  priority: number;
  content: ReactNode;
}
export const useTabBarContent = create<{ items: LocalContribution[] }>(() => ({ items: [] }));

/** Register content in its owner's effect; disposal cannot remove a replacement. */
export function registerTabBarContent(item: LocalContribution): () => void {
  useTabBarContent.setState((state) => ({
    items: [...state.items.filter((old) => old.tabId !== item.tabId || old.id !== item.id), item],
  }));
  return () =>
    useTabBarContent.setState((state) => ({ items: state.items.filter((old) => old !== item) }));
}
export function useTabBarContribution(tabId: string, id: string, content: ReactNode, priority = 0) {
  useLayoutEffect(
    () => (content == null ? undefined : registerTabBarContent({ tabId, id, content, priority })),
    [tabId, id, content, priority],
  );
}

export const usePluginTabBar = create<TabBarSnapshot>(() => ({ revision: -1, items: [] }));
export async function wireTabBarContributions(signal: AbortSignal) {
  let disposed = false;
  let request = 0;
  const accept = (snapshot: TabBarSnapshot) => {
    if (!disposed && !signal.aborted && snapshot.revision >= usePluginTabBar.getState().revision)
      usePluginTabBar.setState(snapshot);
  };
  const refresh = async () => {
    const current = ++request;
    try {
      const snapshot = await invoke<TabBarSnapshot>("plugin_tab_bar_snapshot");
      if (current === request) accept(snapshot);
    } catch (error) {
      if (!disposed && !signal.aborted)
        console.error("Could not synchronize tab bar contributions", error);
    }
  };
  const group = createSubscriptionGroup([
    (lifetime) =>
      nativeEvents.on(
        "plugin://tab-bar-changed",
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
          usePluginTabBar.setState({ items: [] });
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
