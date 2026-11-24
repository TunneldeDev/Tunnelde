import type { ConfigurationPlugin, ConfigurationServices } from "../data/services";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { presentError } from "@/lib/api/errors";
import type { ConfigurationSnapshot } from "@/lib/extensions/contracts/configuration/document";
import { fieldDraft, parseDraft } from "../data/values";

export function useConfigurationModel(
  plugin: ConfigurationPlugin,
  visible: boolean,
  services: ConfigurationServices,
) {
  const { client, useViewState, useBusyGuard } = services;
  const key = `configuration:${plugin.id}:${plugin.fingerprint ?? ""}`;
  const [snapshot, setSnapshot] = useViewState<ConfigurationSnapshot | null>(
    `${key}:snapshot`,
    null,
  );
  const [draft, setDraft] = useViewState<Record<string, string>>(`${key}:draft`, {});
  const [dirty, setDirty] = useViewState(`${key}:dirty`, false);
  const [pending, setPending] = useState(true);
  const [outdated, setOutdated] = useViewState(`${key}:outdated`, false);
  const [error, setError] = useViewState<string | null>(`${key}:error`, null);
  const active = useRef(false),
    shown = useRef(visible),
    lock = useRef(false);
  const sequence = useRef(0),
    observed = useRef<string | null>(null),
    edits = useRef(dirty);
  const loadedRevision = useRef<string | null>(snapshot?.revision ?? null);
  const loaded = useRef(snapshot);
  useBusyGuard(pending);
  useLayoutEffect(() => {
    shown.current = visible;
  }, [visible]);
  const apply = (next: ConfigurationSnapshot) => {
    setSnapshot(next);
    loaded.current = next;
    loadedRevision.current = next.revision;
    setDraft(
      Object.fromEntries(
        next.schema.fields.map((field) => [field.id, fieldDraft(field, next.values[field.id])]),
      ),
    );
    edits.current = false;
    setDirty(false);
    setOutdated(observed.current !== null && observed.current !== next.revision);
  };
  const run = async (operation: () => Promise<ConfigurationSnapshot>, preserveDraft = false) => {
    if (!active.current || !shown.current || lock.current) return;
    const current = ++sequence.current;
    lock.current = true;
    setPending(true);
    setError(null);
    try {
      const next = await operation();
      if (active.current && current === sequence.current && !preserveDraft) apply(next);
    } catch (error) {
      if (active.current && current === sequence.current) setError(presentError(error));
    } finally {
      if (active.current && current === sequence.current) {
        lock.current = false;
        setPending(false);
      }
    }
  };
  const reload = () => run(() => client.get(plugin.id, plugin.fingerprint ?? ""), false);
  useEffect(() => {
    const serial = sequence;
    active.current = true;
    const controller = new AbortController();
    const current = ++sequence.current;
    lock.current = true;
    // Subscribe before reading, so a concurrent writer cannot leave a silently stale form.
    void services
      .observe((event) => {
        if (event.pluginId !== plugin.id) return;
        observed.current = event.revision;
        setOutdated(event.revision !== loadedRevision.current);
      }, controller.signal)
      .then(() => client.get(plugin.id, plugin.fingerprint ?? ""))
      .then((next) => {
        if (active.current && sequence.current === current) {
          // A restored dirty draft keeps its original CAS revision. Reading a newer
          // document must not silently rebase old values onto that revision.
          if (!edits.current || !loaded.current) {
            setSnapshot(next);
            loaded.current = next;
            loadedRevision.current = next.revision;
            if (!edits.current)
              setDraft(
                Object.fromEntries(
                  next.schema.fields.map((field) => [
                    field.id,
                    fieldDraft(field, next.values[field.id]),
                  ]),
                ),
              );
          }
          setOutdated((observed.current ?? next.revision) !== loadedRevision.current);
        }
      })
      .catch((error) => {
        if (active.current && sequence.current === current) setError(presentError(error));
      })
      .finally(() => {
        if (active.current && sequence.current === current) {
          lock.current = false;
          setPending(false);
        }
      });
    return () => {
      active.current = false;
      serial.current++;
      controller.abort();
    };
  }, [
    plugin.id,
    plugin.fingerprint,
    services,
    client,
    setDraft,
    setError,
    setOutdated,
    setSnapshot,
  ]);
  const values: Record<string, unknown> = Object.create(null);
  const invalid: string[] = [];
  for (const field of snapshot?.schema.fields ?? []) {
    const parsed = parseDraft(field, draft[field.id] ?? "");
    if (!parsed.valid) invalid.push(field.id);
    else values[field.id] = parsed.value;
  }
  const expected = snapshot && {
    expectedRevision: snapshot.revision,
    schemaDigest: snapshot.schemaDigest,
  };
  return {
    snapshot,
    draft,
    dirty,
    pending,
    outdated,
    error,
    invalid,
    reload,
    change: (key: string, value: string) => {
      edits.current = true;
      setDirty(true);
      setDraft((old) => ({ ...old, [key]: value }));
    },
    save: () =>
      expected &&
      snapshot?.status === "ready" &&
      !invalid.length &&
      run(() => client.update(plugin.id, plugin.fingerprint ?? "", { ...expected, values })),
    migrate: () =>
      expected && run(() => client.migrate(plugin.id, plugin.fingerprint ?? "", expected)),
    restore: (backupId: string) =>
      expected &&
      run(() => client.restore(plugin.id, plugin.fingerprint ?? "", { ...expected, backupId })),
    deleteBackup: (backupId: string) =>
      expected &&
      run(async () => {
        await client.deleteBackup(plugin.id, plugin.fingerprint ?? "", { ...expected, backupId });
        // Retain all unsaved field edits when deleting a historical backup.
        return snapshot;
      }, true),
  };
}
