import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useHosts } from "@/store/hosts";
import { usePlugins } from "@/store/plugins";
import { useSettings } from "@/store/settings";
import { useWorkspace } from "@/store/workspace";
import { useQuickAccess } from "@/store/quickAccess";
import { useSearchRoots, type SearchRoot } from "@/store/searchRoots";
import { useEditors } from "@/store/editors";
import { useSsh } from "@/store/ssh";
import { shortcutCommands } from "@/lib/keyboard/registry";
import { api } from "@/lib/api/ipc";
import { translateError } from "@/lib/api/errors";
import { toast } from "@/store/toasts";
import { searchPathKey } from "@/lib/files/searchPaths";
import { quickAccessQuery } from "../data/query";
import { quickAccessRoots } from "../data/roots";
import { buildQuickAccessResults } from "../data/results";
import { filterQuickAccessResults } from "../data/filter";
import type { QuickAccessResult } from "../data/model";
import { useQuickAccessSearch } from "./useSearch";
export const QUICK_ACCESS_PAGE_SIZE = 100;
export function useQuickAccessController(initialQuery: string) {
  const { t } = useTranslation();
  const hosts = useHosts((s) => s.hosts),
    plugins = usePlugins((s) => s.items),
    settings = useSettings((s) => s.settings);
  const tabs = useWorkspace((s) => s.tabs),
    activeTabId = useWorkspace((s) => s.activeId);
  const published = useSearchRoots((s) => s.roots),
    entries = useEditors((s) => s.entries),
    sessions = useSsh((s) => s.sessions);
  const [query, setQuery] = useState(initialQuery),
    [index, setIndex] = useState(0),
    [rootId, setRootId] = useState("");
  const [picked, setPicked] = useState<SearchRoot | null>(null);
  const [owner] = useState(() => useQuickAccess.getState().generation);
  const parsed = useMemo(() => quickAccessQuery(query), [query]);
  const { mode, needle, selection, parsedQuery, canSearch } = parsed;
  const definitions = useMemo(() => shortcutCommands(plugins), [plugins]);
  const roots = useMemo(
    () => quickAccessRoots(published, entries, picked, activeTabId, sessions),
    [published, entries, picked, activeTabId, sessions],
  );
  const root = rootId ? roots.find((item) => item.id === rootId) : roots[0];
  const path = root?.path,
    sessionId = root?.sessionId ?? null;
  const searchKey = `${mode}\0${sessionId}\0${path}\0${needle}\0${JSON.stringify(selection)}`;
  const { result, searching, error, setFailure } = useQuickAccessSearch(
    mode,
    path,
    sessionId,
    needle,
    searchKey,
    canSearch,
    selection,
    setIndex,
  );
  const commands = useMemo(
    () =>
      buildQuickAccessResults({
        mode,
        definitions,
        t,
        settings,
        hosts,
        tabs,
        result,
        searchKey,
        path,
        entries,
        activeTabId,
        needle,
        sessionId,
        parsedQuery,
        plugins,
      }),
    [
      mode,
      definitions,
      t,
      settings,
      hosts,
      tabs,
      result,
      searchKey,
      path,
      entries,
      activeTabId,
      needle,
      sessionId,
      parsedQuery,
      plugins,
    ],
  );
  const filtered = useMemo(
    () => filterQuickAccessResults(commands.items, parsedQuery, mode, hosts, definitions),
    [commands, parsedQuery, mode, hosts, definitions],
  );
  const current = Math.min(index, Math.max(0, filtered.length - 1));
  const offset = Math.floor(current / QUICK_ACCESS_PAGE_SIZE) * QUICK_ACCESS_PAGE_SIZE;
  const visible = filtered.slice(offset, offset + QUICK_ACCESS_PAGE_SIZE);
  const frame = useMemo(
    () => ({
      revision: crypto.randomUUID(),
      filtered,
      current,
      query,
      root,
      searching,
      error,
      settings,
    }),
    [filtered, current, query, root, searching, error, settings],
  );
  const committed = useRef<object | null>(null),
    executed = useRef(false);
  useLayoutEffect(() => {
    committed.current = frame;
    return () => {
      committed.current = null;
    };
  }, [frame]);
  // Factories expose checks, never host stores or closures to plugins.
  const validate = () =>
    committed.current === frame &&
    !executed.current &&
    useQuickAccess.getState().query !== null &&
    useQuickAccess.getState().generation === owner &&
    useHosts.getState().hosts === hosts &&
    usePlugins.getState().items === plugins &&
    useEditors.getState().entries === entries &&
    useSettings.getState().settings === settings &&
    useWorkspace.getState().tabs === tabs &&
    useWorkspace.getState().activeId === activeTabId &&
    useSearchRoots.getState().roots === published &&
    useSsh.getState().sessions === sessions;
  const close = useQuickAccess((s) => s.close);
  const run = (command: QuickAccessResult | undefined) => {
    if (!command) return;
    if (!validate() || !filtered.includes(command)) throw new Error("plugin.quickAccess.changed");
    executed.current = true;
    close();
    command.run();
  };
  const runNative = (command: QuickAccessResult | undefined) => {
    try {
      run(command);
    } catch (error) {
      toast(translateError(error), "error");
    }
  };
  const mounted = useRef(true);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const folderEpoch = useRef(0);
  const chooseFolder = () => {
    const epoch = ++folderEpoch.current;
    void api
      .pluginPickFolder(t("palette.chooseFolder"))
      .then((folder) => {
        if (!mounted.current || epoch !== folderEpoch.current || !folder) return;
        const existing = roots.find(
          (item) =>
            !item.sessionId && searchPathKey(item.path, null) === searchPathKey(folder, null),
        );
        if (existing) setRootId(existing.id);
        else {
          setPicked({ id: "picked", path: folder, sessionId: null });
          setRootId("picked");
        }
        setIndex(0);
      })
      .catch((cause) => {
        if (mounted.current && epoch === folderEpoch.current)
          setFailure({ key: searchKey, message: translateError(cause) });
      });
  };
  return {
    ...parsed,
    query,
    setQuery: (value: string) => {
      if (value === query) return;
      committed.current = null;
      setQuery(value);
      setIndex(0);
    },
    index: current,
    setIndex: (value: number) => {
      if (value === current) return;
      committed.current = null;
      setIndex(value);
    },
    offset,
    visible,
    filtered,
    definitions,
    hosts,
    plugins,
    settings,
    roots,
    root,
    sessions,
    setRootId: (value: string) => {
      if (value === rootId) return;
      committed.current = null;
      setRootId(value);
      setIndex(0);
    },
    result,
    limited: commands.limited,
    searchKey,
    searching,
    error,
    frame,
    validate,
    close,
    run,
    runNative,
    chooseFolder,
  };
}
export type QuickAccessController = ReturnType<typeof useQuickAccessController>;
