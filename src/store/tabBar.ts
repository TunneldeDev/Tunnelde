import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { useLayoutEffect, type ReactNode } from "react";
import { synchronizeContributions, nativeContributionSource } from "@/lib/plugins/contributionSync";
import type { TabBarSnapshot } from "@/lib/plugins/tabBar";
import type { MenuAction } from "@/components/ui/overlay/menuTypes";

export interface TabBarContributionOptions {
  placement?: "leading" | "trailing";
  group?: string;
  /** Equivalent menu actions, used when the tab strip has insufficient room. */
  overflowActions?: MenuAction[];
}
interface LocalContribution extends TabBarContributionOptions {
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
export function useTabBarContribution(
  tabId: string,
  id: string,
  content: ReactNode,
  priority = 0,
  options?: TabBarContributionOptions,
) {
  useLayoutEffect(
    () =>
      content == null
        ? undefined
        : registerTabBarContent({ tabId, id, content, priority, ...options }),
    [tabId, id, content, priority, options],
  );
}

export const usePluginTabBar = create<TabBarSnapshot>(() => ({ revision: -1, items: [] }));
export function wireTabBarContributions(signal: AbortSignal) {
  return synchronizeContributions<TabBarSnapshot>(
    nativeContributionSource("plugin://tab-bar-changed", {
      read: () => invoke("plugin_tab_bar_snapshot"),
      apply: (snapshot) => usePluginTabBar.setState(snapshot),
      clear: () => usePluginTabBar.setState({ items: [] }),
      report: (error) => console.error("Could not synchronize tab bar contributions", error),
    }),
    signal,
  );
}
