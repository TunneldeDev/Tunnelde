// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/form/Button";
import { ConnectDialog } from "@/features/connect/ConnectDialog";
import { Dialog } from "@/components/ui/overlay/Dialog";
import { Field, Input, Switch, Textarea } from "@/components/ui/form/Field";
import { Select } from "@/components/ui/form/Select";
import { AUTH_LABELS, AUTH_METHODS } from "@/lib/prefs/labels";
import { parseTags } from "@/lib/text/format";
import type { AuthMethod, Group, Host } from "@/lib/api/types";
import { useDialogs } from "@/store/dialogs";
import { useHosts } from "@/store/hosts";
import { useWorkspace } from "@/store/workspace";

interface HostFormState {
  name: string;
  host: string;
  port: string;
  username: string;
  authMethod: AuthMethod;
  groupId: string;
  keyPath: string;
  favorite: boolean;
  tags: string;
  note: string;
}

const EMPTY: HostFormState = {
  name: "",
  host: "",
  port: "22",
  username: "",
  authMethod: "password",
  groupId: "",
  keyPath: "",
  favorite: false,
  tags: "",
  note: "",
};

function fromHost(host: Host): HostFormState {
  return {
    name: host.name,
    host: host.host,
    port: String(host.port),
    username: host.username,
    authMethod: host.authMethod,
    groupId: host.groupId ?? "",
    keyPath: host.keyPath ?? "",
    favorite: host.favorite,
    tags: host.tags.join(", "),
    note: host.note ?? "",
  };
}

function HostDialog({ host, onClose }: { host: Host | null; onClose: () => void }) {
  const { t } = useTranslation();
  const groups = useHosts((state) => state.groups);
  const createHost = useHosts((state) => state.createHost);
  const updateHost = useHosts((state) => state.updateHost);
  const openHost = useWorkspace((state) => state.openHost);
  const renameHost = useWorkspace((state) => state.renameHost);
  const [form, setForm] = useState<HostFormState>(host ? fromHost(host) : EMPTY);
  const [errors, setErrors] = useState<{ name?: string; host?: string; port?: string }>({});
  const [saving, setSaving] = useState(false);

  const set = <K extends keyof HostFormState>(key: K, value: HostFormState[K]) => {
    setForm((current) => ({ ...current, [key]: value }));
  };

  const submit = async () => {
    const nextErrors: typeof errors = {};
    if (!form.name.trim()) {
      nextErrors.name = t("error.required");
    }
    if (!form.host.trim()) {
      nextErrors.host = t("error.required");
    }
    const port = Number.parseInt(form.port, 10);
    if (!Number.isFinite(port) || port < 1 || port > 65535) {
      nextErrors.port = t("error.invalidPort");
    }
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) {
      return;
    }

    const input = {
      name: form.name.trim(),
      host: form.host.trim(),
      port,
      username: form.username.trim(),
      authMethod: form.authMethod,
      groupId: form.groupId || null,
      keyPath: form.authMethod === "key" ? form.keyPath.trim() || null : null,
      favorite: form.favorite,
      tags: parseTags(form.tags),
      note: form.note.trim() || null,
    };

    setSaving(true);
    if (host) {
      const updated = await updateHost(host.id, input);
      if (updated) {
        renameHost(updated.id, updated.name);
        onClose();
      }
    } else {
      const created = await createHost(input);
      if (created) {
        openHost(created);
        onClose();
      }
    }
    setSaving(false);
  };

  return (
    <Dialog
      open
      title={host ? t("host.editTitle") : t("host.newTitle")}
      closeLabel={t("common.close")}
      onClose={onClose}
      width={460}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button variant="primary" disabled={saving} onClick={() => void submit()}>
            {t("common.save")}
          </Button>
        </>
      }
    >
      <form
        className="form-grid"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <Field label={t("host.name")} error={errors.name} htmlFor="host-name">
          <Input
            id="host-name"
            autoFocus
            value={form.name}
            placeholder={t("host.namePlaceholder")}
            onChange={(event) => set("name", event.target.value)}
          />
        </Field>

        <div className="form-row">
          <Field
            label={t("host.address")}
            error={errors.host}
            htmlFor="host-address"
            className="grow"
          >
            <Input
              id="host-address"
              value={form.host}
              placeholder={t("host.addressPlaceholder")}
              spellCheck={false}
              onChange={(event) => set("host", event.target.value)}
            />
          </Field>
          <Field label={t("host.port")} error={errors.port} htmlFor="host-port" className="port">
            <Input
              id="host-port"
              inputMode="numeric"
              value={form.port}
              onChange={(event) => set("port", event.target.value.replace(/[^\d]/g, ""))}
            />
          </Field>
        </div>

        <div className="form-row">
          <Field label={t("host.username")} htmlFor="host-user" className="grow">
            <Input
              id="host-user"
              value={form.username}
              placeholder={t("host.usernamePlaceholder")}
              spellCheck={false}
              onChange={(event) => set("username", event.target.value)}
            />
          </Field>
          <Field label={t("host.authMethod")} htmlFor="host-auth" className="grow">
            <Select
              id="host-auth"
              label={t("host.authMethod")}
              value={form.authMethod}
              options={AUTH_METHODS.map((method) => ({
                value: method,
                label: t(AUTH_LABELS[method]),
              }))}
              onChange={(value) => set("authMethod", value as AuthMethod)}
            />
          </Field>
        </div>

        <div className="form-row">
          <Field label={t("host.group")} htmlFor="host-group" className="grow">
            <Select
              id="host-group"
              label={t("host.group")}
              value={form.groupId}
              options={[
                { value: "", label: t("common.none") },
                ...groups.map((group) => ({ value: group.id, label: group.name })),
              ]}
              onChange={(value) => set("groupId", value)}
            />
          </Field>
          <Field label={t("host.favorite")} className="switch-field">
            <Switch
              label={t("host.favorite")}
              checked={form.favorite}
              onChange={(favorite) => set("favorite", favorite)}
            />
          </Field>
        </div>

        {form.authMethod === "key" ? (
          <Field label={t("host.keyPath")} htmlFor="host-key-path">
            <Input
              id="host-key-path"
              value={form.keyPath}
              placeholder="~/.ssh/id_ed25519"
              spellCheck={false}
              onChange={(event) => set("keyPath", event.target.value)}
            />
          </Field>
        ) : null}

        <Field label={t("host.tags")} htmlFor="host-tags">
          <Input
            id="host-tags"
            value={form.tags}
            placeholder={t("host.tagsPlaceholder")}
            spellCheck={false}
            onChange={(event) => set("tags", event.target.value)}
          />
        </Field>

        <Field label={t("host.note")} htmlFor="host-note">
          <Textarea
            id="host-note"
            rows={3}
            value={form.note}
            onChange={(event) => set("note", event.target.value)}
          />
        </Field>
      </form>
    </Dialog>
  );
}

function GroupDialog({ group, onClose }: { group: Group | null; onClose: () => void }) {
  const { t } = useTranslation();
  const createGroup = useHosts((state) => state.createGroup);
  const renameGroup = useHosts((state) => state.renameGroup);
  const [name, setName] = useState(group?.name ?? "");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    const value = name.trim();
    if (!value) {
      setError(t("error.required"));
      return;
    }
    setSaving(true);
    if (group) {
      await renameGroup(group.id, value);
    } else {
      await createGroup(value);
    }
    setSaving(false);
    onClose();
  };

  return (
    <Dialog
      open
      title={group ? t("group.editTitle") : t("group.newTitle")}
      closeLabel={t("common.close")}
      onClose={onClose}
      width={380}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button variant="primary" disabled={saving} onClick={() => void submit()}>
            {t("common.save")}
          </Button>
        </>
      }
    >
      <Field label={t("group.name")} error={error} htmlFor="group-name">
        <Input
          id="group-name"
          autoFocus
          value={name}
          placeholder={t("group.namePlaceholder")}
          onChange={(event) => {
            setName(event.target.value);
            setError(null);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void submit();
            }
          }}
        />
      </Field>
    </Dialog>
  );
}

function ConfirmDialog({
  title,
  body,
  confirmLabel,
  danger,
  onConfirm,
  onClose,
}: {
  title: string;
  body: string;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => void | Promise<void>;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);

  const run = async () => {
    setBusy(true);
    try {
      await onConfirm();
    } finally {
      setBusy(false);
      onClose();
    }
  };

  return (
    <Dialog
      open
      title={title}
      closeLabel={t("common.close")}
      onClose={onClose}
      width={400}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button
            variant={danger ? "danger" : "primary"}
            disabled={busy}
            onClick={() => void run()}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <p className="dialog-text">{body}</p>
    </Dialog>
  );
}

export function DialogHost() {
  const dialog = useDialogs((state) => state.dialog);
  const close = useDialogs((state) => state.close);

  switch (dialog.kind) {
    case "host":
      return <HostDialog key={dialog.host?.id ?? "new"} host={dialog.host} onClose={close} />;
    case "group":
      return <GroupDialog key={dialog.group?.id ?? "new"} group={dialog.group} onClose={close} />;
    case "connect":
      return (
        <ConnectDialog
          key={dialog.host.id}
          host={dialog.host}
          after={dialog.after}
          onClose={close}
        />
      );
    case "confirm":
      return (
        <ConfirmDialog
          title={dialog.title}
          body={dialog.body}
          confirmLabel={dialog.confirmLabel}
          danger={dialog.danger}
          onConfirm={dialog.onConfirm}
          onClose={close}
        />
      );
    default:
      return null;
  }
}
