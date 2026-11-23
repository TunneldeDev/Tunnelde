import { useWorkspace } from "@/store/workspace";
import { useSettings } from "@/store/settings";
import { useFileClipboard } from "@/store/fileClipboard";
import { useFileHighlights } from "@/store/fileHighlights";
import { usePlugins } from "@/store/plugins";
import { usePanelWindows } from "@/store/panelWindows";
import { filePagePreferenceProjection } from "./filePageServices";
import { filePageProps, useFileWindowRegistrations } from "./fileWindowRegistration";
import { installedIconThemes } from "@/lib/files/icons";
import { fileViewPreferenceKey, readFileViewPreferences } from "@/lib/files/preferences";
import { previewProviders } from "@/lib/files/preview";
import type { FileWindowModel } from "./fileWindowModel";
import type { PanelWindowClient } from "@/lib/panels/windowClient";
import type { WindowModelAppearance } from "@/app/panelReadModels";
export function fileWindowViews(id: string) {
  const tab = useWorkspace.getState().tabs.find((t) => t.id === id);
  const entry = useFileWindowRegistrations.getState().entries.get(id);
  if (!tab || !entry) return {};
  const props = filePageProps(tab),
    settings = useSettings.getState().settings;
  const owner = (sessionId: string) => {
    const s = entry.sessions.find((s) => s.id === sessionId);
    return s?.hostId ? `host:${s.hostId}` : `session:${sessionId}`;
  };
  return Object.fromEntries(
    ["a", "b"].flatMap((pane) =>
      entry.sources.map((s) => {
        const key = fileViewPreferenceKey(
          "main",
          props.scopeId ?? owner(props.sessionId),
          pane,
          s.kind === "local" ? "local" : owner(s.sessionId),
        );
        return [
          key,
          readFileViewPreferences(key, {
            filesShowHidden: settings.filesShowHidden,
            filesFoldersFirst: settings.filesFoldersFirst,
            filesSortBy: settings.filesSortBy,
            filesSortDirection: settings.filesSortDirection,
          }),
        ];
      }),
    ),
  );
}
export function startFileWindowPublication(
  client: PanelWindowClient,
  appearance: () => WindowModelAppearance,
  failure: (e: unknown) => void,
) {
  let disposed = false,
    running = false,
    queued = false;
  const publishers = new Map<string, { id: string; revision: number; encoded?: string }>();
  const refresh = () => {
    if (disposed) return;
    queued = true;
    if (running) return;
    running = true;
    void (async () => {
      try {
        while (queued && !disposed) {
          queued = false;
          for (const [id, registration] of useFileWindowRegistrations.getState().entries) {
            const tab = useWorkspace.getState().tabs.find((t) => t.id === id && t.kind === "sftp");
            if (
              !tab ||
              !usePanelWindows.getState().snapshot.filePages?.some((v) => v.panelId === id)
            )
              continue;
            let publisher = publishers.get(id);
            if (!publisher) {
              publisher = {
                id: await client.control<string>({ action: "beginModel", panelId: id }),
                revision: 0,
              };
              publishers.set(id, publisher);
            }
            const settings = useSettings.getState().settings,
              plugins = usePlugins.getState().items;
            const themes = installedIconThemes(plugins);
            const theme =
              settings.fileIconTheme === "none"
                ? undefined
                : settings.fileIconTheme === "auto"
                  ? themes[0]
                  : themes.find((t) => t.id === settings.fileIconTheme);
            const model: FileWindowModel = {
              ...appearance(),
              files: {
                props: filePageProps(tab),
                tab,
                sessions: registration.sessions,
                clip: useFileClipboard.getState().clip,
                preferences: filePagePreferenceProjection(settings),
                shortcuts: {
                  keyboardShortcuts: settings.keyboardShortcuts,
                  shortcutRules: settings.shortcutRules,
                },
                views: fileWindowViews(id),
                highlights: Array.from(useFileHighlights.getState().bySource.entries()),
                icons: theme?.theme,
                previews: previewProviders(plugins),
                menus: plugins.flatMap((plugin) =>
                  plugin.commands.flatMap((command) =>
                    command.fileMenu
                      ? [
                          {
                            sources: command.fileMenu.sources.filter((source) =>
                              plugin.permissions.includes(
                                source === "local" ? "fs.read" : "sftp.read",
                              ),
                            ),
                            kinds: command.fileMenu.kinds,
                            extensions: command.fileMenu.extensions,
                            action: {
                              pluginId: plugin.id,
                              pluginName: plugin.name,
                              command: command.id,
                              title: command.title,
                              fingerprint: plugin.fingerprint,
                              first: false,
                            },
                          },
                        ]
                      : [],
                  ),
                ),
                providersSelected: !!settings.uiProviders.fileBrowser,
              },
            };
            const encoded = JSON.stringify(model);
            if (disposed || publisher.encoded === encoded) continue;
            await client.control({
              action: "publishModel",
              panelId: id,
              publisher: publisher.id,
              revision: ++publisher.revision,
              model,
            });
            publisher.encoded = encoded;
          }
          for (const id of [...publishers.keys()])
            if (!useFileWindowRegistrations.getState().entries.has(id)) publishers.delete(id);
        }
      } catch (e) {
        publishers.clear();
        if (!disposed) failure(e);
      } finally {
        running = false;
        if (queued && !disposed) refresh();
      }
    })();
  };
  const stop = [
    useWorkspace.subscribe(refresh),
    useSettings.subscribe(refresh),
    useFileClipboard.subscribe(refresh),
    useFileHighlights.subscribe(refresh),
    usePlugins.subscribe(refresh),
    usePanelWindows.subscribe(refresh),
    useFileWindowRegistrations.subscribe(refresh),
  ];
  refresh();
  return {
    refresh,
    dispose() {
      disposed = true;
      for (const s of stop) s();
      publishers.clear();
    },
  };
}
