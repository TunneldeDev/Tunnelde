import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { PluginInfo } from "@/lib/api/types";
import { pluginConfigurationApi as client } from "@/lib/api/plugins/configuration";
import { translateError } from "@/lib/api/errors";
import { nativeEvents } from "@/lib/events/native";
import type { ConfigurationSnapshot } from "@/lib/extensions/contracts/configuration/document";
import { fieldDraft, parseDraft } from "../data/values";

export function useConfiguration(plugin: PluginInfo, visible: boolean) {
  const [snapshot, setSnapshot] = useState<ConfigurationSnapshot | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [dirty, setDirty] = useState(false);
  const [pending, setPending] = useState(true);
  const [outdated, setOutdated] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const active = useRef(false),
    shown = useRef(visible),
    lock = useRef(false);
  const sequence = useRef(0),
    observed = useRef<string | null>(null),
    edits = useRef(false);
  const loadedRevision = useRef<string | null>(null);
  useLayoutEffect(() => {
    shown.current = visible;
  }, [visible]);
  const apply = (next: ConfigurationSnapshot) => {
    setSnapshot(next);
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
      if (active.current && current === sequence.current) setError(translateError(error));
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
    void nativeEvents
      .on(
        "plugin://configuration-changed",
        (event) => {
          if (event.pluginId !== plugin.id) return;
          observed.current = event.revision;
          setOutdated(event.revision !== loadedRevision.current);
        },
        controller.signal,
      )
      .then(() => client.get(plugin.id, plugin.fingerprint ?? ""))
      .then((next) => {
        if (active.current && sequence.current === current) {
          setSnapshot(next);
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
          setOutdated(observed.current !== null && observed.current !== next.revision);
        }
      })
      .catch((error) => {
        if (active.current && sequence.current === current) setError(translateError(error));
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
  }, [plugin.id, plugin.fingerprint]);
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
