// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

import { api, events, isTauri } from "@/lib/ipc";
import { applyAppearance } from "@/lib/appearance";
import i18n from "@/i18n/i18n";
import { translateError } from "@/lib/errors";
import type { TabRecord } from "@/lib/types";
import { toast } from "@/store/toasts";
import { useHosts } from "@/store/hosts";
import { useSsh } from "@/store/ssh";
import { useSettings } from "@/store/settings";
import { useUpdates } from "@/store/updates";
import { useWorkspace } from "@/store/workspace";

let started = false;
let persistTimer: number | undefined;

export async function bootstrap(): Promise<void> {
  if (started) {
    return;
  }
  started = true;

  await useSettings.getState().load();

  if (!isTauri()) {
    useWorkspace.getState().ensureWelcome();
    return;
  }

  try {
    const records = await api.tabs();
    useWorkspace.getState().hydrate(records);
    await useHosts.getState().load();
    await useSsh.getState().refresh();
    pruneMissingHosts();
    pruneMissingSessions();
    useWorkspace.getState().ensureWelcome();
    await useUpdates.getState().refresh();
    await wireEvents();
  } catch (error) {
    toast(translateError(error), "error");
    useWorkspace.getState().ensureWelcome();
  }

  useWorkspace.subscribe(() => {
    window.clearTimeout(persistTimer);
    persistTimer = window.setTimeout(() => {
      const records: TabRecord[] = useWorkspace.getState().tabs.map((tab, index) => ({
        id: tab.id,
        kind: tab.kind,
        title: tab.title,
        hostId: tab.hostId,
        sortOrder: index,
        pinned: tab.pinned,
        state: null,
      }));
      void api.saveTabs(records).catch(() => undefined);
    }, 400);
  });
}

function pruneMissingHosts(): void {
  const known = new Set(useHosts.getState().hosts.map((host) => host.id));
  for (const tab of useWorkspace.getState().tabs) {
    if (tab.kind === "host" && tab.hostId && !known.has(tab.hostId)) {
      useWorkspace.getState().close(tab.id);
    }
  }
}

function pruneMissingSessions(): void {
  const open = new Set(useSsh.getState().sessions.map((session) => session.id));
  for (const tab of useWorkspace.getState().tabs) {
    if (tab.kind === "terminal" && !open.has(tab.id.replace("terminal:", ""))) {
      useWorkspace.getState().close(tab.id);
    }
  }
}

async function wireEvents(): Promise<void> {
  await events.onSettingsChanged((settings) => {
    useSettings.getState().applyRemote(settings);
  });

  await events.onUpdateState((state) => {
    useUpdates.getState().apply(state);
  });

  await events.onNavigate((page) => {
    if (page === "settings" || page === "about" || page === "updates") {
      useWorkspace.getState().openPage(page);
    }
  });

  await events.onSshClosed((payload) => {
    useSsh.getState().forget(payload.sessionId);
    useWorkspace.getState().closeSession(payload.sessionId);
    toast(i18n.t("ssh.sessionEnded"), "info");
  });

  const media = window.matchMedia("(prefers-color-scheme: light)");
  media.addEventListener("change", () => {
    const settings = useSettings.getState().settings;
    if (settings.theme === "system") {
      applyAppearance(settings);
    }
  });
}
