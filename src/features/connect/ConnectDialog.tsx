import { ShieldAlert, ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/form/Button";
import { Dialog } from "@/components/ui/overlay/Dialog";
import { ConnectionQuality } from "@/features/connect/ConnectionQuality";
import { Field, Input, Switch } from "@/components/ui/form/Field";
import { cn } from "@/lib/text/format";
import { translateError } from "@/lib/api/errors";
import { api } from "@/lib/api/ipc";
import { createReviewedConnection, type ConnectionReview } from "@/lib/api/connections/review";
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
  after?: "terminal" | "sftp" | "background";
  intent?: "connect" | "installKey";
  initialError?: string;
  onClose: () => void;
  purpose?: "forwarding";
  context?: ReactNode;
  /** Optional exclusive host acquisition, with its own native lifetime. */
  connectSession?: (request: SshConnectRequest, review?: ConnectionReview) => Promise<SshSession>;
  /** Native verification for acquisitions pinned to a previously captured target. */
  verification?: {
    /** Request-owned route, captured before the originating native consent. */
    jumpHosts?: Host[];
    probe: (credentials: SshConnectRequest["jumpCredentials"]) => Promise<HostKeyInfo>;
    trust: (
      fingerprint: string,
      credentials: SshConnectRequest["jumpCredentials"],
      expectedHostId?: string,
    ) => Promise<HostKeyInfo>;
  };
  onConnected?: (session: SshSession) => void | Promise<void>;
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
  purpose,
  connectSession,
  verification,
  context,
}: ConnectDialogProps) {
  const { t } = useTranslation();
  const connect = useSsh((state) => state.connect);
  const openTerminal = useWorkspace((state) => state.openTerminal);
  const openSftp = useWorkspace((state) => state.openSftp);
  const confirm = useDialogs((state) => state.confirm);

  const hosts = useHosts((state) => state.hosts);
  const [reviewed] = useState(() => createReviewedConnection(host));
  const [reviewedJumps, setReviewedJumps] = useState<Host[]>([]);
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
  const [reviewChanged, setReviewChanged] = useState(false);
  const [error, setError] = useState<string | null>(initialError ?? null);
  const reportError = useCallback(
    (cause: unknown) => {
      const message = isIpcError(cause) || cause instanceof Error ? cause.message : null;
      if (message === "ssh.connectionChanged") {
        setReviewChanged(true);
        setTrusted(false);
        setProbe(null);
        setPassword("");
        setPassphrase("");
        setJumpCredentials({});
        setError(t("connect.reviewChanged"));
      } else {
        setError(translateError(cause));
      }
    },
    [t],
  );
  const alive = useRef(true);
  const pending = useRef(false);
  const probeHost = useCallback(
    (credentials?: SshConnectRequest["jumpCredentials"]) =>
      verification ? verification.probe(credentials ?? {}) : reviewed.probe(credentials ?? {}),
    [reviewed, verification],
  );

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    let alive = true;
    probeHost()
      .then((info) => {
        if (!alive) {
          return;
        }
        setProbe(info);
        setTrusted(info.status === "known" && (!info.hostId || info.hostId === host.id));
      })
      .catch((cause: unknown) => {
        if (alive) {
          reportError(cause);
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
  }, [host.id, probeHost, reportError]);

  useEffect(() => {
    if (host.source) return;
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
  }, [host.id, host.source]);

  useEffect(() => {
    let active = true;
    void (
      verification
        ? verification.jumpHosts
          ? Promise.resolve({ jumpHosts: verification.jumpHosts })
          : api.connectionRoute(host.id).then((route) => ({
              jumpHosts: route.jumpHosts
                .map((id) => hosts.find((item) => item.id === id))
                .filter((item): item is Host => !!item),
            }))
        : reviewed.prepare()
    )
      .then(async (route) => {
        if (!active) return;
        setReviewedJumps(route.jumpHosts);
        setJumpIds(route.jumpHosts.map((jump) => jump.id));
        const statuses = await Promise.all(
          route.jumpHosts.map(async ({ id }) => [id, await api.credentialStatus(id)] as const),
        );
        if (active) setJumpSaved(Object.fromEntries(statuses));
      })
      .catch((cause) => {
        if (active) reportError(cause);
      });
    return () => {
      active = false;
    };
  }, [host.id, reviewed, verification, hosts, reportError]);

  const verifyRoute = async () => {
    if (pending.current || reviewChanged) return;
    pending.current = true;
    setProbing(true);
    setError(null);
    setTrusted(false);
    try {
      const info = await probeHost(jumpCredentials);
      if (alive.current) {
        setProbe(info);
        setTrusted(info.status === "known" && (!info.hostId || info.hostId === host.id));
      }
    } catch (cause) {
      if (alive.current) reportError(cause);
    } finally {
      pending.current = false;
      if (alive.current) setProbing(false);
    }
  };

  const setup = intent === "installKey" && !host.source;
  const unsupported = !setup && host.authMethod === "agent";
  const interactive = setup || (host.authMethod !== "key" && !unsupported);
  const hasCredentials = !interactive || password.length > 0 || saved;
  const canConnect =
    !reviewChanged && trusted && !probing && !busy && !testing && !unsupported && hasCredentials;

  const trust = async () => {
    if (pending.current || !probe) {
      return;
    }
    pending.current = true;
    setBusy(true);
    setError(null);
    let approved = false;
    try {
      const info = await (verification
        ? verification.trust(probe.fingerprint, jumpCredentials, probe.hostId)
        : reviewed.trust(probe.fingerprint, jumpCredentials, probe.hostId || host.id));
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
          const next = await probeHost(jumpCredentials);
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
        reportError(cause);
        if (isIpcError(cause) && cause.message === "ssh.hostKeyChanged") {
          try {
            const info = await probeHost(jumpCredentials);
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
    const acquire = connectSession
      ? async (request: SshConnectRequest, onError: (error: unknown) => void) => {
          try {
            return await connectSession(
              request,
              verification ? undefined : await reviewed.review(),
            );
          } catch (error) {
            onError(error);
            return null;
          }
        }
      : (request: SshConnectRequest, onError: (error: unknown) => void) =>
          connect(request, onError, { key: reviewed.key, connect: reviewed.connect });
    const session = await acquire(
      {
        hostId: host.id,
        background: after === "background",
        purpose,
        jumpCredentials,
        password: interactive ? password || null : null,
        passphrase: interactive ? null : passphrase || null,
        cols: 120,
        rows: 32,
      },
      (cause) => {
        if (alive.current) reportError(cause);
      },
    );
    if (!session) {
      pending.current = false;
      if (alive.current) {
        setBusy(false);
      }
      return;
    }
    if (!alive.current) return;
    if (!verification && !host.source && interactive && remember && password.length > 0) {
      try {
        await reviewed.credential(host.id, password);
      } catch (cause) {
        toast(translateError(cause), "error");
      }
    }
    if (!verification && rememberJumps) {
      for (const [id, credentials] of Object.entries(jumpCredentials)) {
        if (credentials.password) {
          try {
            await reviewed.credential(id, credentials.password);
          } catch (cause) {
            toast(translateError(cause), "error");
          }
        }
      }
    }
    try {
      if (onConnected) {
        if (alive.current) await onConnected(session);
      } else if (after === "sftp") {
        openSftp(session);
      } else if (after === "terminal") {
        openTerminal(session);
      }
      if (alive.current) onClose();
    } catch (cause) {
      if (alive.current) reportError(cause);
    } finally {
      pending.current = false;
      if (alive.current) setBusy(false);
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
          await reviewed.credential(host.id, null);
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
      verification ||
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
      await reviewed.installKey(password || null, jumpCredentials);
      await useHosts.getState().load();
      toast(t("connect.installKeyDone"), "success");
      if (alive.current) {
        onClose();
      }
    } catch (cause) {
      if (alive.current) {
        reportError(cause);
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
        {context}
        {host.source && <p className="connect__hint">{t("hostSources.connectionHint")}</p>}
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
              const jump = reviewedJumps.find((item) => item.id === id);
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
                    disabled={busy || probing || reviewChanged}
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
            {!verification && (
              <Switch
                label={t("network.jumpRemember")}
                checked={rememberJumps}
                onChange={setRememberJumps}
                disabled={busy || reviewChanged}
              />
            )}
            <Button
              variant="secondary"
              size="sm"
              disabled={probing || busy || reviewChanged}
              onClick={() => void verifyRoute()}
            >
              {t("network.verifyRoute")}
            </Button>
          </div>
        ) : null}

        {!reviewChanged && (
          <div className={cn("key-box", status === "changed" && "is-danger")}>
            <div className="key-box__head">
              <span className="key-box__title">
                {status === "known" ? <ShieldCheck size={13} /> : <ShieldAlert size={13} />}
                {probe?.hostId && probe.hostId !== host.id
                  ? t("network.keyFor", {
                      name: reviewedJumps.find((h) => h.id === probe.hostId)?.name ?? probe.hostId,
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
        )}

        {!verification && !reviewChanged && (
          <ConnectionQuality
            hostId={host.id}
            credentials={jumpCredentials}
            testConnection={reviewed.test}
            enabled={trusted && !probing && !busy}
            onTesting={setTesting}
            onKeyError={() => {
              setTrusted(false);
              void verifyRoute();
            }}
          />
        )}

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
                disabled={busy || reviewChanged}
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
            {!setup && !host.source && !verification ? (
              <div className="connect__remember">
                <Switch
                  label={t("connect.remember")}
                  checked={remember}
                  disabled={busy || reviewChanged}
                  onChange={setRemember}
                />
                <span className="connect__remember-label">{t("connect.remember")}</span>
                {saved ? (
                  <Button
                    variant="ghost-danger"
                    size="sm"
                    disabled={busy || reviewChanged}
                    onClick={forget}
                  >
                    {t("connect.forget")}
                  </Button>
                ) : null}
              </div>
            ) : null}
            {!setup && !host.source && !verification ? (
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
              disabled={busy || reviewChanged}
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
