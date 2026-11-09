import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/form/Button";
import { Field, Input } from "@/components/ui/form/Field";
import { Select } from "@/components/ui/form/Select";
import { api } from "@/lib/api/ipc";
import { translateError } from "@/lib/api/errors";
import { nativeEvents } from "@/lib/events/native";
import {
  reconcileHostFields,
  validHostField,
  type HostField,
  type HostFieldsSnapshot,
  type HostFieldValue,
} from "@/lib/hosts/fields";
import { usePlugins } from "@/store/plugins";
import { useDialogs } from "@/store/dialogs";
import type { PluginInfo } from "@/lib/api/types";
import "./hostFields.css";

type Draft = Record<string, string>;
const toDraft = (values: Record<string, HostFieldValue>): Draft =>
  Object.fromEntries(Object.entries(values).map(([key, value]) => [key, String(value)]));

function FieldForm({ hostId, plugin }: { hostId: string; plugin: PluginInfo }) {
  const { t } = useTranslation();
  const id = useId();
  const [snapshot, setSnapshot] = useState<HostFieldsSnapshot | null>(null);
  const [draft, setDraft] = useState<Draft>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [pending, setPending] = useState(true);
  const [dirty, setDirty] = useState(false);
  const [outdated, setOutdated] = useState(false);
  const [reconciled, setReconciled] = useState(false);
  const [saved, setSaved] = useState(false);
  const live = useRef(false);
  const request = useRef(0);
  const editing = useRef(false);
  const busy = useRef(false);
  const observedRevision = useRef(0);
  const confirm = useDialogs((state) => state.confirm);

  const apply = (next: HostFieldsSnapshot) => {
    setSnapshot(next);
    setDraft(toDraft(next.document.values));
    setDirty(false);
    editing.current = false;
    setOutdated(false);
    setReconciled(false);
  };
  const load = useCallback(async () => {
    const generation = ++request.current;
    busy.current = true;
    try {
      let next = await api.hostFields(plugin.id, hostId);
      // Events carry no values; a read overtaken by a commit must resynchronize.
      let retries = 0;
      while (
        live.current &&
        generation === request.current &&
        !editing.current &&
        next.document.revision < observedRevision.current &&
        retries++ < 3
      ) {
        next = await api.hostFields(plugin.id, hostId);
      }
      if (live.current && generation === request.current) {
        if (editing.current) setOutdated(true);
        else {
          apply(next);
          if (next.document.revision < observedRevision.current) setOutdated(true);
        }
      }
    } catch (error) {
      if (live.current && generation === request.current) setFailure(translateError(error));
    } finally {
      if (live.current && generation === request.current) {
        busy.current = false;
        setPending(false);
      }
    }
  }, [hostId, plugin.id]);
  useEffect(() => {
    live.current = true;
    const sequence = request;
    const controller = new AbortController();
    void nativeEvents
      .on(
        "hosts://fields-changed",
        (event) => {
          if (event.pluginId !== plugin.id || event.hostId !== hostId) return;
          observedRevision.current = Math.max(observedRevision.current, event.revision);
          if (editing.current || busy.current) setOutdated(true);
          else void load();
        },
        controller.signal,
      )
      .then(() => {
        if (!controller.signal.aborted) void load();
      })
      .catch((error) => {
        if (!controller.signal.aborted) {
          setFailure(translateError(error));
          void load();
        }
      });
    return () => {
      live.current = false;
      sequence.current++;
      controller.abort();
    };
  }, [hostId, plugin.id, plugin.fingerprint, load]);

  const change = (field: HostField, value: string | undefined) => {
    editing.current = true;
    setDirty(true);
    setSaved(false);
    setDraft((current) => {
      const next: Draft = Object.assign(Object.create(null), current);
      if (value === undefined) delete next[field.id];
      else next[field.id] = value;
      return next;
    });
  };
  const values: Record<string, HostFieldValue> = Object.create(null);
  const invalid = new Set<string>();
  for (const field of snapshot?.schema.fields ?? []) {
    if (!Object.hasOwn(draft, field.id)) continue;
    const raw = draft[field.id]!;
    const value =
      field.type === "number"
        ? raw.trim()
          ? Number(raw)
          : NaN
        : field.type === "boolean"
          ? raw === "true"
          : raw;
    if (!validHostField(field, value)) invalid.add(field.id);
    else values[field.id] = value;
  }
  const schemaBlocked = !!snapshot?.document.schemaChanged && !reconciled;
  const save = async () => {
    if (!snapshot || busy.current || invalid.size || schemaBlocked) return;
    const generation = ++request.current;
    busy.current = true;
    setPending(true);
    setFailure(null);
    try {
      const next = await api.updateHostFields(plugin.id, {
        hostId,
        expectedRevision: snapshot.document.revision,
        schemaDigest: snapshot.document.schemaDigest,
        values,
      });
      if (live.current && generation === request.current) {
        apply(next);
        if (next.document.revision < observedRevision.current) setOutdated(true);
        setSaved(true);
      }
    } catch (error) {
      if (live.current && generation === request.current) setFailure(translateError(error));
    } finally {
      if (live.current && generation === request.current) {
        busy.current = false;
        setPending(false);
      }
    }
  };
  const reload = () => {
    const reloadSaved = () => {
      editing.current = false;
      setPending(true);
      setFailure(null);
      setSaved(false);
      return load();
    };
    if (dirty)
      confirm({
        title: t("hostFields.reloadTitle"),
        body: t("hostFields.reloadBody"),
        confirmLabel: t("hostFields.reload"),
        onConfirm: reloadSaved,
      });
    else void reloadSaved();
  };

  return (
    <div className="host-fields__body">
      {failure && (
        <p role="alert" className="td-field__error">
          {failure}
        </p>
      )}
      {outdated && <p role="status">{t("hostFields.outdated")}</p>}
      {schemaBlocked && (
        <div className="host-fields__warning" role="alert">
          <p>{t("hostFields.schemaChanged")}</p>
          <details>
            <summary>{t("hostFields.storedValues")}</summary>
            <pre>{JSON.stringify(snapshot?.document.values, null, 2)}</pre>
          </details>
          <Button
            variant="secondary"
            disabled={pending}
            onClick={() =>
              confirm({
                title: t("hostFields.reconcile"),
                body: t("hostFields.reconcileBody"),
                confirmLabel: t("hostFields.reconcile"),
                onConfirm: () => {
                  if (snapshot && live.current) {
                    setDraft(toDraft(reconcileHostFields(snapshot)));
                    setReconciled(true);
                    setDirty(true);
                    editing.current = true;
                  }
                },
              })
            }
          >
            {t("hostFields.reconcile")}
          </Button>
        </div>
      )}
      {!snapshot && pending && <p role="status">{t("common.loading")}</p>}
      {snapshot && (
        <fieldset disabled={pending || schemaBlocked} className="host-fields__fields">
          {snapshot.schema.fields.map((field) => {
            const present = Object.hasOwn(draft, field.id);
            const fieldId = `${id}-${field.id}`;
            return (
              <Field
                key={field.id}
                label={field.label}
                htmlFor={fieldId}
                hint={field.description}
                error={invalid.has(field.id) ? t("hostFields.invalidField") : undefined}
              >
                <div className="host-fields__control">
                  {field.type === "boolean" || field.type === "select" ? (
                    <Select
                      id={fieldId}
                      label={field.label}
                      disabled={pending || schemaBlocked}
                      value={present ? draft[field.id]! : ""}
                      options={[
                        { value: "", label: t("hostFields.unset") },
                        ...(field.type === "boolean"
                          ? [
                              { value: "true", label: t("hostFields.yes") },
                              { value: "false", label: t("hostFields.no") },
                            ]
                          : (field.options ?? [])),
                      ]}
                      onChange={(value) => change(field, value === "" ? undefined : value)}
                    />
                  ) : (
                    <Input
                      id={fieldId}
                      type={field.type === "number" ? "number" : "text"}
                      step={field.type === "number" ? "any" : undefined}
                      min={field.minimum}
                      max={field.maximum}
                      aria-invalid={invalid.has(field.id)}
                      placeholder={t("hostFields.unset")}
                      value={present ? draft[field.id]! : ""}
                      onChange={(event) => change(field, event.target.value)}
                    />
                  )}
                  {present && (
                    <Button variant="ghost" size="sm" onClick={() => change(field, undefined)}>
                      {t("hostFields.unsetValue")}
                    </Button>
                  )}
                </div>
              </Field>
            );
          })}
        </fieldset>
      )}
      <div className="host-fields__actions">
        <Button
          variant="primary"
          size="sm"
          disabled={pending || !dirty || schemaBlocked || invalid.size > 0}
          onClick={() => void save()}
        >
          {t("common.save")}
        </Button>
        <Button variant="secondary" size="sm" disabled={pending} onClick={reload}>
          {t("hostFields.reload")}
        </Button>
        {saved && <span role="status">{t("hostFields.saved")}</span>}
      </div>
    </div>
  );
}

function PluginFields({ hostId, plugin }: { hostId: string; plugin: PluginInfo }) {
  const [visited, setVisited] = useState(false);
  return (
    <details
      className="host-fields__plugin"
      onToggle={(event) => {
        if (event.currentTarget.open) setVisited(true);
      }}
    >
      <summary>
        <span>{plugin.name}</span>
        <small>{plugin.id}</small>
      </summary>
      {visited && <FieldForm hostId={hostId} plugin={plugin} />}
    </details>
  );
}

export function HostFieldsSection({ hostId }: { hostId: string }) {
  const { t } = useTranslation();
  const plugins = usePlugins((state) => state.items);
  const contributors = plugins
    .filter((plugin) => plugin.hostFields)
    .sort((a, b) => a.name.localeCompare(b.name));
  if (!contributors.length) return null;
  return (
    <section className="card host-fields" aria-label={t("hostFields.title")}>
      <h2 className="card__title">{t("hostFields.title")}</h2>
      <p className="host-fields__hint">{t("hostFields.hint")}</p>
      {contributors.map((plugin) => (
        <PluginFields key={`${hostId}:${plugin.id}`} hostId={hostId} plugin={plugin} />
      ))}
    </section>
  );
}
