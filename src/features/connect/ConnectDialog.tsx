// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

import { ShieldAlert, ShieldCheck } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/form/Button";
import { Dialog } from "@/components/ui/overlay/Dialog";
import { Field, Input, Switch } from "@/components/ui/form/Field";
import { cn } from "@/lib/text/format";
import { translateError } from "@/lib/api/errors";
import { api } from "@/lib/api/ipc";
import type { Host, HostKeyInfo } from "@/lib/api/types";
import { useDialogs } from "@/store/dialogs";
import { useHosts } from "@/store/hosts";
import { useSsh } from "@/store/ssh";
import { toast } from "@/store/toasts";
import { useWorkspace } from "@/store/workspace";

const STATUS_KEYS = {
  known: "connect.knownKey",
  unknown: "connect.unknownKey",
  changed: "connect.changedKey",
} as const;

interface ConnectDialogProps {
  host: Host;
  after?: "terminal" | "sftp";
  intent?: "connect" | "installKey";
  onClose: () => void;
}

export function ConnectDialog({
  host,
  after = "terminal",
  intent = "connect",
  onClose,
}: ConnectDialogProps) {
  const { t } = useTranslation();
  const connect = useSsh((state) => state.connect);
  const openTerminal = useWorkspace((state) => state.openTerminal);
  const openSftp = useWorkspace((state) => state.openSftp);
  const confirm = useDialogs((state) => state.confirm);

  const [probe, setProbe] = useState<HostKeyInfo | null>(null);
  const [trusted, setTrusted] = useState(false);
  const [probing, setProbing] = useState(true);
  const [password, setPassword] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [saved, setSaved] = useState(false);
  const [remember, setRemember] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  const pending = useRef(false);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    let alive = true;
    api
      .sshProbe(host.id)
      .then((info) => {
        if (!alive) {
          return;
        }
        setProbe(info);
        setTrusted(info.status === "known");
      })
      .catch((cause: unknown) => {
        if (alive) {
          setError(translateError(cause));
        }
      })
      .finally(() => {
        if (alive) {
          setProbing(false);
        }
      });
    return () => {
      alive = false;
    };
  }, [host.id]);

  useEffect(() => {
    let alive = true;
    api
      .credentialStatus(host.id)
      .then((value) => {
        if (alive) {
          setSaved(value);
        }
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [host.id]);

  const setup = intent === "installKey";
  const unsupported = !setup && host.authMethod === "agent";
  const interactive = setup || (host.authMethod !== "key" && !unsupported);
  const canConnect =
    trusted && !probing && !busy && !unsupported && (!interactive || password.length > 0 || saved);

  const trust = async () => {
    if (pending.current) {
      return;
    }
    pending.current = true;
    setBusy(true);
    setError(null);
    try {
      const info = await api.sshTrust(host.id);
      if (!alive.current) {
        return;
      }
      setProbe(info);
      setTrusted(true);
    } catch (cause) {
      if (alive.current) {
        setError(translateError(cause));
      }
    } finally {
      pending.current = false;
      if (alive.current) {
        setBusy(false);
      }
    }
  };

  const submit = async () => {
    if (!canConnect || pending.current) {
      return;
    }
    pending.current = true;
    setBusy(true);
    setError(null);
    const session = await connect({
      hostId: host.id,
      password: interactive ? password || null : null,
      passphrase: interactive ? null : passphrase || null,
      cols: 120,
      rows: 32,
    });
    if (!session) {
      pending.current = false;
      if (alive.current) {
        setBusy(false);
      }
      return;
    }
    if (interactive && remember && password.length > 0) {
      try {
        await api.credentialSave(host.id, password);
      } catch (cause) {
        toast(translateError(cause), "error");
      }
    }
    if (after === "sftp") {
      openSftp(session);
    } else {
      openTerminal(session);
    }
    pending.current = false;
    if (alive.current) {
      setBusy(false);
      onClose();
    }
  };

  const forget = () => {
    confirm({
      title: t("connect.forgetTitle"),
      body: t("connect.forgetBody", { name: host.name }),
      confirmLabel: t("connect.forget"),
      danger: true,
      onConfirm: async () => {
        try {
          await api.credentialForget(host.id);
          setSaved(false);
          setPassword("");
        } catch (cause) {
          toast(translateError(cause), "error");
        }
      },
    });
  };

  const installKey = async () => {
    if (pending.current || !trusted || unsupported || (password.length === 0 && !saved)) {
      return;
    }
    pending.current = true;
    setBusy(true);
    setError(null);
    try {
      // No typed password means the backend falls back to the keychain copy.
      await api.sshInstallKey(host.id, password || null);
      await useHosts.getState().load();
      toast(t("connect.installKeyDone"), "success");
      if (alive.current) {
        onClose();
      }
    } catch (cause) {
      if (alive.current) {
        setError(translateError(cause));
      }
    } finally {
      pending.current = false;
      if (alive.current) {
        setBusy(false);
      }
    }
  };

  const status = probe?.status ?? null;
  const keyStatus = status ? t(STATUS_KEYS[status]) : t("connect.probing");

  return (
    <Dialog
      open
      title={
        setup
          ? `${t("connect.installKey")} · ${host.name}`
          : t("connect.title", { name: host.name })
      }
      closeLabel={t("common.close")}
      onClose={onClose}
      dismissible={!busy}
      width={440}
      footer={
        <>
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button
            variant="primary"
            disabled={!canConnect}
            onClick={() => void (setup ? installKey() : submit())}
          >
            {setup ? t("connect.installKey") : t("connect.connect")}
          </Button>
        </>
      }
    >
      <div className="connect">
        {setup ? (
          <p className="connect__hint">
            {t("connect.installKeyHint", {
              defaultValue:
                "Sign in once with your password to add Tunnelde’s public key to this account and use key login for future connections. Existing authorized keys are preserved.",
            })}
          </p>
        ) : null}
        <div className="connect__target">
          <code>
            {host.username ? `${host.username}@` : ""}
            {host.host}:{host.port}
          </code>
        </div>

        <div className={cn("key-box", status === "changed" && "is-danger")}>
          <div className="key-box__head">
            <span className="key-box__title">
              {status === "known" ? <ShieldCheck size={13} /> : <ShieldAlert size={13} />}
              {t("connect.hostKey")}
            </span>
            <span className={cn("key-box__status", status === "known" && "is-ok")}>
              {probing ? t("connect.probing") : keyStatus}
            </span>
          </div>
          {probe ? <code className="key-box__fingerprint">{probe.fingerprint}</code> : null}
          {probe?.knownFingerprint && probe.knownFingerprint !== probe.fingerprint ? (
            <code className="key-box__fingerprint key-box__fingerprint--old">
              {t("connect.previousKey")}: {probe.knownFingerprint}
            </code>
          ) : null}
          {status && status !== "known" ? (
            <>
              <p className="key-box__hint">
                {status === "unknown" ? t("connect.unknownHint") : t("connect.changedHint")}
              </p>
              <Button
                size="sm"
                variant={status === "changed" ? "danger" : "secondary"}
                disabled={busy}
                onClick={() => void trust()}
              >
                {status === "changed" ? t("connect.replaceKey") : t("connect.trustHost")}
              </Button>
            </>
          ) : null}
        </div>

        {interactive ? (
          <>
            <Field
              label={t("connect.password")}
              hint={saved && password.length === 0 ? t("connect.savedHint") : undefined}
              htmlFor="connect-password"
            >
              <Input
                id="connect-password"
                type="password"
                disabled={busy}
                autoFocus
                autoComplete="off"
                placeholder={saved ? "••••••••" : undefined}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void (setup ? installKey() : submit());
                  }
                }}
              />
            </Field>
            {!setup ? (
              <div className="connect__remember">
                <Switch
                  label={t("connect.remember")}
                  checked={remember}
                  disabled={busy}
                  onChange={setRemember}
                />
                <span className="connect__remember-label">{t("connect.remember")}</span>
                {saved ? (
                  <Button variant="ghost-danger" size="sm" disabled={busy} onClick={forget}>
                    {t("connect.forget")}
                  </Button>
                ) : null}
              </div>
            ) : null}
            {!setup ? (
              <div className="connect__actions">
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy || !trusted || (password.length === 0 && !saved)}
                  onClick={() => void installKey()}
                >
                  {t("connect.installKey")}
                </Button>
              </div>
            ) : null}
          </>
        ) : host.authMethod === "key" ? (
          <Field
            label={t("connect.passphrase")}
            hint={t("connect.optional")}
            htmlFor="connect-passphrase"
          >
            <Input
              id="connect-passphrase"
              type="password"
              disabled={busy}
              autoFocus
              autoComplete="off"
              value={passphrase}
              onChange={(event) => setPassphrase(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void submit();
                }
              }}
            />
          </Field>
        ) : null}

        {!trusted && status !== null && !probing ? (
          <p className="connect__hint">{t("connect.trustHint")}</p>
        ) : null}

        {error ? <p className="connect__error">{error}</p> : null}
        {unsupported ? <p className="connect__error">{t("ssh.agentUnsupported")}</p> : null}
      </div>
    </Dialog>
  );
}
