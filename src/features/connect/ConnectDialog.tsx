import { ShieldAlert, ShieldCheck } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/form/Button";
import { Dialog } from "@/components/ui/overlay/Dialog";
import { ConnectionQuality } from "@/features/connect/ConnectionQuality";
import { Field, Input, Switch } from "@/components/ui/form/Field";
import { cn } from "@/lib/text/format";
import { translateError } from "@/lib/api/errors";
import { api } from "@/lib/api/ipc";
import {
  isIpcError,
  type Host,
  type HostKeyInfo,
  type SshConnectRequest,
  type SshSession,
} from "@/lib/api/types";
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
  initialError?: string;
  onClose: () => void;
  onConnected?: (session: SshSession) => void;
}

export function ConnectDialog(props: ConnectDialogProps) {
  const host = props.host;
  const scope = JSON.stringify([
    host.id,
    host.host,
    host.port,
    host.username,
    host.authMethod,
    host.keyPath,
  ]);
  return <HostConnectDialog key={scope} {...props} />;
}

function HostConnectDialog({
  host,
  after = "terminal",
  intent = "connect",
  initialError,
  onClose,
  onConnected,
}: ConnectDialogProps) {
  const { t } = useTranslation();
  const connect = useSsh((state) => state.connect);
  const openTerminal = useWorkspace((state) => state.openTerminal);
  const openSftp = useWorkspace((state) => state.openSftp);
  const confirm = useDialogs((state) => state.confirm);

  const hosts = useHosts((state) => state.hosts);
  const [jumpIds, setJumpIds] = useState<string[]>([]);
  const [jumpCredentials, setJumpCredentials] = useState<
    NonNullable<SshConnectRequest["jumpCredentials"]>
  >({});
  const [jumpSaved, setJumpSaved] = useState<Record<string, boolean>>({});
  const [rememberJumps, setRememberJumps] = useState(true);
  const [probe, setProbe] = useState<HostKeyInfo | null>(null);
  const [trusted, setTrusted] = useState(false);
  const [probing, setProbing] = useState(true);
  const [password, setPassword] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [saved, setSaved] = useState(false);
  const [remember, setRemember] = useState(true);
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<string | null>(initialError ?? null);
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
        setTrusted(info.status === "known" && (!info.hostId || info.hostId === host.id));
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

  useEffect(() => {
    let active = true;
    void api
      .connectionRoute(host.id)
      .then(async (route) => {
        if (!active) return;
        setJumpIds(route.jumpHosts);
        const statuses = await Promise.all(
          route.jumpHosts.map(async (id) => [id, await api.credentialStatus(id)] as const),
        );
        if (active) setJumpSaved(Object.fromEntries(statuses));
      })
      .catch((cause) => {
        if (active) setError(translateError(cause));
      });
    return () => {
      active = false;
    };
  }, [host.id]);

  const verifyRoute = async () => {
    if (pending.current) return;
    pending.current = true;
    setProbing(true);
    setError(null);
    setTrusted(false);
    try {
      const info = await api.sshProbe(host.id, jumpCredentials);
      if (alive.current) {
        setProbe(info);
        setTrusted(info.status === "known" && (!info.hostId || info.hostId === host.id));
      }
    } catch (cause) {
      if (alive.current) setError(translateError(cause));
    } finally {
      pending.current = false;
      if (alive.current) setProbing(false);
    }
  };

  const setup = intent === "installKey";
  const unsupported = !setup && host.authMethod === "agent";
  const interactive = setup || (host.authMethod !== "key" && !unsupported);
  const hasCredentials = !interactive || password.length > 0 || saved;
  const canConnect = trusted && !probing && !busy && !testing && !unsupported && hasCredentials;

  const trust = async () => {
    if (pending.current || !probe) {
      return;
    }
    pending.current = true;
    setBusy(true);
    setError(null);
    let approved = false;
    try {
      const info = await (probe.hostId
        ? api.sshTrust(
            host.id,
            probe.fingerprint,
            jumpIds.length ? jumpCredentials : undefined,
            probe.hostId,
          )
        : jumpIds.length
          ? api.sshTrust(host.id, probe.fingerprint, jumpCredentials)
          : api.sshTrust(host.id, probe.fingerprint));
      if (!alive.current) {
        return;
      }
      setProbe(info);
      const finalHost = !info.hostId || info.hostId === host.id;
      setTrusted(finalHost);
      approved = finalHost;
      if (!finalHost) {
        setProbing(true);
        try {
          const next = await api.sshProbe(host.id, jumpCredentials);
          if (alive.current) {
            setProbe(next);
            approved = next.status === "known" && (!next.hostId || next.hostId === host.id);
            setTrusted(approved);
          }
        } finally {
          if (alive.current) setProbing(false);
        }
      }
    } catch (cause) {
      if (alive.current) {
        setError(translateError(cause));
        if (isIpcError(cause) && cause.message === "ssh.hostKeyChanged") {
          try {
            const info = await api.sshProbe(host.id, jumpCredentials);
            if (alive.current) {
              setProbe(info);
              setTrusted(info.status === "known" && (!info.hostId || info.hostId === host.id));
            }
          } catch {
            // Keep the old fingerprint untrusted until the dialog is reopened.
            if (alive.current) setTrusted(false);
          }
        }
      }
    } finally {
      pending.current = false;
      if (alive.current) {
        setBusy(false);
      }
    }
    if (approved && alive.current && !setup && hasCredentials) await submit(true);
  };

  const submit = async (justApproved = false) => {
    const ready = justApproved
      ? !probing && !testing && !unsupported && hasCredentials
      : canConnect;
    if (!ready || pending.current) {
      return;
    }
    pending.current = true;
    setBusy(true);
    setError(null);
    const session = await connect(
      {
        hostId: host.id,
        jumpCredentials,
        password: interactive ? password || null : null,
        passphrase: interactive ? null : passphrase || null,
        cols: 120,
        rows: 32,
      },
      (cause) => {
        if (alive.current) setError(translateError(cause));
      },
    );
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
    if (rememberJumps) {
      for (const [id, credentials] of Object.entries(jumpCredentials)) {
        if (credentials.password) {
          try {
            await api.credentialSave(id, credentials.password);
          } catch (cause) {
            toast(translateError(cause), "error");
          }
        }
      }
    }
    if (onConnected) {
      if (alive.current) onConnected(session);
    } else if (after === "sftp") {
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
    if (
      pending.current ||
      testing ||
      !trusted ||
      unsupported ||
      (password.length === 0 && !saved)
    ) {
      return;
    }
    pending.current = true;
    setBusy(true);
    setError(null);
    try {
      // No typed password means the backend falls back to the keychain copy.
      await (jumpIds.length
        ? api.sshInstallKey(host.id, password || null, jumpCredentials)
        : api.sshInstallKey(host.id, password || null));
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

        {jumpIds.length ? (
          <div className="form-grid">
            {jumpIds.map((id) => {
              const jump = hosts.find((item) => item.id === id);
              if (!jump)
                return (
                  <p key={id} className="connect__error">
                    {t("network.hostMissing")}
                  </p>
                );
              const key = jump.authMethod === "key";
              return (
                <Field
                  key={id}
                  label={t("network.jumpCredential", { name: jump.name })}
                  hint={
                    jumpSaved[id] && !key
                      ? t("connect.savedHint")
                      : key
                        ? t("connect.optional")
                        : undefined
                  }
                >
                  <Input
                    type="password"
                    aria-label={`${jump.name} · ${t(key ? "connect.passphrase" : "connect.password")}`}
                    autoComplete="off"
                    disabled={busy || probing}
                    placeholder={
                      jumpSaved[id] && !key
                        ? "••••••••"
                        : t(key ? "connect.passphrase" : "connect.password")
                    }
                    value={
                      (key ? jumpCredentials[id]?.passphrase : jumpCredentials[id]?.password) ?? ""
                    }
                    onChange={(event) => {
                      setJumpCredentials((current) => ({
                        ...current,
                        [id]: {
                          ...current[id],
                          [key ? "passphrase" : "password"]: event.target.value,
                        },
                      }));
                      setTrusted(false);
                    }}
                  />
                </Field>
              );
            })}
            <Switch
              label={t("network.jumpRemember")}
              checked={rememberJumps}
              onChange={setRememberJumps}
              disabled={busy}
            />
            <Button
              variant="secondary"
              size="sm"
              disabled={probing || busy}
              onClick={() => void verifyRoute()}
            >
              {t("network.verifyRoute")}
            </Button>
          </div>
        ) : null}

        <div className={cn("key-box", status === "changed" && "is-danger")}>
          <div className="key-box__head">
            <span className="key-box__title">
              {status === "known" ? <ShieldCheck size={13} /> : <ShieldAlert size={13} />}
              {probe?.hostId && probe.hostId !== host.id
                ? t("network.keyFor", {
                    name: hosts.find((h) => h.id === probe.hostId)?.name ?? probe.hostId,
                  })
                : t("connect.hostKey")}
            </span>
            <span className={cn("key-box__status", status === "known" && "is-ok")}>
              {probing ? t("connect.probing") : keyStatus}
            </span>
          </div>
          {probe ? <code className="key-box__fingerprint">{probe.fingerprint}</code> : null}
          {probe?.connectionTimeMs != null && !probing ? (
            <p className="connect__hint">
              {t("connect.probeTime", { value: probe.connectionTimeMs })}
            </p>
          ) : null}
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
                disabled={busy || testing}
                onClick={() => void trust()}
              >
                {status === "changed" ? t("connect.replaceKey") : t("connect.trustHost")}
              </Button>
            </>
          ) : null}
        </div>

        <ConnectionQuality
          hostId={host.id}
          credentials={jumpCredentials}
          enabled={trusted && !probing && !busy}
          onTesting={setTesting}
          onKeyError={() => {
            setTrusted(false);
            void verifyRoute();
          }}
        />

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
                  disabled={busy || testing || !trusted || (password.length === 0 && !saved)}
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
