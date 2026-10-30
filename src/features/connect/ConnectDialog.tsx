// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

import { ShieldAlert, ShieldCheck } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Field, Input, Switch } from "@/components/ui/Field";
import { cn } from "@/lib/format";
import { translateError } from "@/lib/errors";
import { api } from "@/lib/ipc";
import type { Host, HostKeyInfo } from "@/lib/types";
import { useDialogs } from "@/store/dialogs";
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
  onClose: () => void;
}

export function ConnectDialog({ host, after = "terminal", onClose }: ConnectDialogProps) {
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

  const interactive = host.authMethod !== "key";
  const canConnect = trusted && !busy && (!interactive || password.length > 0 || saved);

  const trust = async () => {
    setBusy(true);
    setError(null);
    try {
      const info = await api.sshTrust(host.id);
      setProbe(info);
      setTrusted(true);
    } catch (cause) {
      setError(translateError(cause));
    } finally {
      setBusy(false);
    }
  };

  const submit = async () => {
    if (!canConnect) {
      return;
    }
    setBusy(true);
    setError(null);
    const session = await connect({
      hostId: host.id,
      password: interactive ? password || null : null,
      passphrase: interactive ? null : passphrase || null,
      cols: 120,
      rows: 32,
    });
    setBusy(false);
    if (!session) {
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
    onClose();
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

  const status = probe?.status ?? null;
  const keyStatus = status ? t(STATUS_KEYS[status]) : t("connect.probing");

  return (
    <Dialog
      open
      title={t("connect.title", { name: host.name })}
      closeLabel={t("common.close")}
      onClose={onClose}
      width={440}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button variant="primary" disabled={!canConnect} onClick={() => void submit()}>
            {t("connect.connect")}
          </Button>
        </>
      }
    >
      <div className="connect">
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
                autoFocus
                autoComplete="off"
                placeholder={saved ? "••••••••" : undefined}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void submit();
                  }
                }}
              />
            </Field>
            <div className="connect__remember">
              <Switch
                label={t("connect.remember")}
                checked={remember}
                onChange={setRemember}
              />
              <span className="connect__remember-label">{t("connect.remember")}</span>
              {saved ? (
                <Button variant="ghost-danger" size="sm" onClick={forget}>
                  {t("connect.forget")}
                </Button>
              ) : null}
            </div>
          </>
        ) : (
          <Field
            label={t("connect.passphrase")}
            hint={t("connect.optional")}
            htmlFor="connect-passphrase"
          >
            <Input
              id="connect-passphrase"
              type="password"
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
        )}

        {!trusted && status !== null && !probing ? (
          <p className="connect__hint">{t("connect.trustHint")}</p>
        ) : null}

        {error ? <p className="connect__error">{error}</p> : null}
      </div>
    </Dialog>
  );
}
