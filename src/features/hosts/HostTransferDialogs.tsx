import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/form/Button";
import { Field, Input } from "@/components/ui/form/Field";
import { SwitchRow } from "@/components/ui/form/Switch";
import { copyText } from "@/lib/session/clipboard";
import { Dialog } from "@/components/ui/overlay/Dialog";
import { indexHostPreview, hostTransferApi, useHostTransfer } from "@/lib/hosts/transfer";
import { translateError } from "@/lib/api/errors";
import { useBackgroundGuard } from "@/lib/session/viewState";
import { useHosts } from "@/store/hosts";
import { useSettings } from "@/store/settings";
import { toast } from "@/store/toasts";
import "@/features/welcome/sshConfigImport.css";
import "./hostTransfer.css";

function updateSelection(current: Set<string>, ids: Iterable<string>, include: boolean) {
  const next = new Set(current);
  for (const id of ids) {
    if (include) next.add(id);
    else next.delete(id);
  }
  return next;
}

export function HostTransferDialogs() {
  const dialog = useHostTransfer((state) => state.dialog);
  if (!dialog) return null;
  return dialog.kind === "import" ? <ImportHosts /> : <ExportHosts ids={dialog.ids} />;
}
function ExportHosts({ ids }: { ids?: string[] }) {
  const { t } = useTranslation();
  const hosts = useHosts((state) => state.hosts).filter((host) => !host.source);
  const [selected, setSelected] = useState(() => new Set(ids ?? hosts.map((host) => host.id)));
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [includeCredentials, setIncludeCredentials] = useState(true);
  const [encrypt, setEncrypt] = useState(true);
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [generated, setGenerated] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const close = useHostTransfer((state) => state.close);
  const filter = query.trim().toLowerCase();
  const visible = hosts.filter((host) =>
    `${host.name} ${host.host} ${host.username}`.toLowerCase().includes(filter),
  );
  const allVisible = visible.length > 0 && visible.every((host) => selected.has(host.id));
  const selectedIds = hosts.filter((host) => selected.has(host.id)).map((host) => host.id);
  useBackgroundGuard(true);
  return (
    <Dialog
      className="host-transfer"
      open
      title={t("hostTransfer.exportTitle")}
      closeLabel={t("common.close")}
      onClose={close}
      dismissible={!busy}
      width={560}
      footer={
        <>
          <Button variant="ghost" disabled={busy} onClick={close}>
            {t("common.cancel")}
          </Button>
          <Button
            variant="primary"
            disabled={busy || !selectedIds.length || (encrypt && generated && !acknowledged)}
            onClick={() => {
              setBusy(true);
              setError(null);
              if (encrypt && !password) {
                void hostTransferApi
                  .generatePassword()
                  .then((value) => {
                    setPassword(value);
                    setGenerated(true);
                    setShowPassword(true);
                    setAcknowledged(false);
                  })
                  .catch((cause) => setError(translateError(cause)))
                  .finally(() => setBusy(false));
                return;
              }
              void hostTransferApi
                .export(selectedIds, {
                  includeCredentials,
                  encrypt,
                  password: encrypt ? password : null,
                })
                .then((path) => {
                  if (path) {
                    toast(t("hostTransfer.exported"), "success");
                    close();
                  }
                })
                .catch((cause) => setError(translateError(cause)))
                .finally(() => setBusy(false));
            }}
          >
            {t("hostTransfer.exportSelected", { count: selectedIds.length })}
          </Button>
        </>
      }
    >
      <div className="ssh-import" aria-busy={busy}>
        <p className="td-field__hint">{t("hostTransfer.exportHint")}</p>
        <SwitchRow
          label={t("hostTransfer.includeCredentials")}
          checked={includeCredentials}
          disabled={busy}
          onChange={(value) => {
            setIncludeCredentials(value);
            if (value) setEncrypt(true);
          }}
        />
        <p className="td-field__hint">{t("hostTransfer.portabilityHint")}</p>
        <SwitchRow
          label={t("hostTransfer.encrypt")}
          hint={includeCredentials ? t("hostTransfer.encryptionRequiredHint") : undefined}
          checked={encrypt}
          disabled={busy || includeCredentials}
          onChange={setEncrypt}
        />
        {encrypt && (
          <>
            <Field
              label={t("hostTransfer.exportPassword")}
              htmlFor="hosts-export-password"
              hint={t("hostTransfer.passwordHint")}
            >
              <Input
                id="hosts-export-password"
                type={showPassword ? "text" : "password"}
                autoComplete="new-password"
                spellCheck={false}
                maxLength={4096}
                disabled={busy}
                value={password}
                onChange={(event) => {
                  setPassword(event.target.value);
                  setGenerated(false);
                  setAcknowledged(false);
                }}
              />
            </Field>
            <div className="host-transfer__actions">
              <Button size="sm" disabled={busy} onClick={() => setShowPassword(!showPassword)}>
                {t(showPassword ? "hostTransfer.hidePassword" : "hostTransfer.showPassword")}
              </Button>
              {password && (
                <Button size="sm" disabled={busy} onClick={() => copyText(password)}>
                  {t("hostTransfer.copyPassword")}
                </Button>
              )}
            </div>
            {generated && (
              <>
                <p role="status" className="td-field__hint">
                  {t("hostTransfer.generatedPasswordHint")}
                </p>
                <label className="ssh-import__entry">
                  <input
                    type="checkbox"
                    disabled={busy}
                    checked={acknowledged}
                    onChange={(event) => setAcknowledged(event.target.checked)}
                  />
                  <span>{t("hostTransfer.passwordSaved")}</span>
                </label>
              </>
            )}
          </>
        )}

        <Input
          aria-label={t("hostTransfer.search")}
          disabled={busy}
          placeholder={t("hostTransfer.search")}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <Button
          size="sm"
          disabled={busy || !visible.length}
          onClick={() =>
            setSelected((current) =>
              updateSelection(
                current,
                visible.map((host) => host.id),
                !allVisible,
              ),
            )
          }
        >
          {t(allVisible ? "hostTransfer.deselectVisible" : "hostTransfer.selectVisible")}
        </Button>
        {!visible.length ? (
          <p className="td-field__hint" role="status">
            {t(hosts.length ? "common.noResults" : "hostTransfer.noSavedHosts")}
          </p>
        ) : (
          <div className="ssh-import__entries">
            {visible.map((host) => (
              <label className="ssh-import__entry" key={host.id}>
                <input
                  type="checkbox"
                  checked={selected.has(host.id)}
                  disabled={busy}
                  onChange={(event) => {
                    const checked = event.target.checked;
                    setSelected((current) => updateSelection(current, [host.id], checked));
                  }}
                />
                <span className="ssh-import__details">
                  <strong className="ssh-import__alias">{host.name}</strong>
                  <span className="ssh-import__address">
                    {host.username}@{host.host}:{host.port}
                  </span>
                </span>
              </label>
            ))}
          </div>
        )}
        {error && (
          <p role="alert" className="td-field__error">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}
function ImportHosts() {
  const { t } = useTranslation();
  const [index, setIndex] = useState<ReturnType<typeof indexHostPreview> | null>(null);
  const preview = index?.preview;
  const picker = useRef<ReturnType<typeof hostTransferApi.pick> | null>(null);
  const [pickAttempt, setPickAttempt] = useState(0);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [copies, setCopies] = useState(false);
  const [mountPoints, setMountPoints] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lockedToken, setLockedToken] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [credentialErrors, setCredentialErrors] = useState<string[] | null>(null);
  const alive = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      queueMicrotask(() => {
        if (!alive.current)
          void picker.current
            ?.then((result) => {
              if (result?.token) return hostTransferApi.release(result.token);
            })
            .catch(() => undefined);
      });
    };
  }, []);
  const close = useHostTransfer((state) => state.close);
  useBackgroundGuard(true);
  useEffect(() => {
    let active = true;
    // StrictMode replays the effect; subscribe again, but open only one native picker.
    picker.current ??= hostTransferApi.pick();
    void picker.current
      .then((result) => {
        if (!active) return;
        if (!result) {
          close();
          return;
        }
        if ("locked" in result) {
          setLockedToken(result.token);
          return;
        }
        setLockedToken(null);
        const next = indexHostPreview(result);
        setIndex(next);
        setChosen(new Set(result.document.roots.filter((id) => !next.blocked.has(id))));
      })
      .catch((cause) => {
        if (active) setError(translateError(cause));
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
    };
  }, [close, pickAttempt]);
  const chooseFile = () => {
    setBusy(true);
    setError(null);
    const previous = picker.current;
    const next = previous
      ?.then(async (result) => {
        if (result?.token) await hostTransferApi.release(result.token);
      })
      .catch(() => undefined);
    setLockedToken(null);
    setPassword("");
    setIndex(null);
    setChosen(new Set());
    setMountPoints({});
    setCopies(false);
    picker.current = Promise.resolve(next).then(() => hostTransferApi.pick());
    setPickAttempt((attempt) => attempt + 1);
  };
  const selected = useMemo(() => index?.expand(chosen) ?? new Set<string>(), [index, chosen]);
  const eligible = useMemo(
    () => (index ? [...index.entries.keys()].filter((id) => copies || !index.blocked.has(id)) : []),
    [index, copies],
  );
  const clearSelection = chosen.size > 0 && eligible.every((id) => selected.has(id));
  const conflict = !copies && [...chosen].some((id) => index?.blocked.has(id));
  const proxyIds = new Set(
    preview?.document.hosts.filter((host) => selected.has(host.id)).map((host) => host.route.proxy),
  );
  const proxies = preview?.document.proxies.filter((proxy) => proxyIds.has(proxy.id));
  return (
    <Dialog
      className="host-transfer"
      open
      title={t("hostTransfer.importTitle")}
      closeLabel={t("common.close")}
      onClose={close}
      dismissible={!busy}
      width={620}
      footer={
        <>
          <Button variant="ghost" disabled={busy} onClick={close}>
            {t("common.cancel")}
          </Button>
          <Button
            disabled={busy || credentialErrors !== null}
            onClick={() => {
              setBusy(true);
              setError(null);
              if (!preview) {
                chooseFile();
                return;
              }
              void hostTransferApi
                .preview(preview)
                .then((result) => setIndex(indexHostPreview(result)))
                .catch((cause) => setError(translateError(cause)))
                .finally(() => setBusy(false));
            }}
          >
            {t(preview ? "sshImport.refresh" : "hostTransfer.chooseFile")}
          </Button>
          {preview && credentialErrors === null && (
            <Button disabled={busy} onClick={chooseFile}>
              {t("hostTransfer.chooseFile")}
            </Button>
          )}
          <Button
            variant="primary"
            disabled={busy || !selected.size || conflict || credentialErrors !== null}
            onClick={() => {
              if (!preview) return;
              setBusy(true);
              setError(null);
              void hostTransferApi
                .apply(preview, [...chosen], copies, mountPoints)
                .then(async (result) => {
                  const { hosts, credentialErrors: errors } = result;
                  for (const host of hosts) useHosts.getState().receiveSavedHost(host);
                  await Promise.all([useHosts.getState().load(), useSettings.getState().load()]);
                  if (errors.length) {
                    setCredentialErrors(errors);
                    return;
                  }
                  toast(t("sshImport.imported", { count: hosts.length }), "success");
                  close();
                })
                .catch((cause) => setError(translateError(cause)))
                .finally(() => setBusy(false));
            }}
          >
            {t("sshImport.importSelected", { count: selected.size })}
          </Button>
        </>
      }
    >
      <div className="ssh-import" aria-busy={busy}>
        <p className="td-field__hint">{t("hostTransfer.importHint")}</p>
        {preview && (
          <p className="td-field__hint">
            {t(
              preview.hasCredentials
                ? "hostTransfer.includedCredentialsHint"
                : "hostTransfer.credentialsHint",
            )}
          </p>
        )}
        {lockedToken && !preview && (
          <>
            <Field
              label={t("hostTransfer.importPassword")}
              htmlFor="hosts-import-password"
              hint={t("hostTransfer.encryptedFileHint")}
            >
              <Input
                id="hosts-import-password"
                type="password"
                autoComplete="off"
                maxLength={4096}
                disabled={busy}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                onKeyDown={(event) => {
                  if (
                    event.key === "Enter" &&
                    !event.nativeEvent.isComposing &&
                    password &&
                    !busy
                  ) {
                    event.preventDefault();
                    document.getElementById("hosts-unlock")?.click();
                  }
                }}
              />
            </Field>
            <Button
              id="hosts-unlock"
              variant="primary"
              disabled={busy || !password}
              onClick={() => {
                setBusy(true);
                setError(null);
                void hostTransferApi
                  .unlock(lockedToken, password)
                  .then((result) => {
                    if ("locked" in result) return;
                    setPassword("");
                    setLockedToken(null);
                    const next = indexHostPreview(result);
                    setIndex(next);
                    setChosen(new Set(result.document.roots.filter((id) => !next.blocked.has(id))));
                  })
                  .catch((cause) => setError(translateError(cause)))
                  .finally(() => setBusy(false));
              }}
            >
              {t("hostTransfer.unlock")}
            </Button>
          </>
        )}
        {credentialErrors !== null && (
          <div role="alert">
            <p>{t("hostTransfer.credentialSaveFailed", { names: credentialErrors.join(", ") })}</p>
            <Button
              disabled={busy || !preview?.token}
              onClick={() => {
                if (!preview?.token) return;
                setBusy(true);
                setError(null);
                void hostTransferApi
                  .retryCredentials(preview.token)
                  .then((result) => {
                    if (result.credentialErrors.length)
                      setCredentialErrors(result.credentialErrors);
                    else {
                      toast(t("sshImport.imported", { count: result.hosts.length }), "success");
                      close();
                    }
                  })
                  .catch((cause) => setError(translateError(cause)))
                  .finally(() => setBusy(false));
              }}
            >
              {t("hostTransfer.retryCredentials")}
            </Button>
          </div>
        )}
        {busy && <p role="status">{t("common.loading")}</p>}
        {preview && credentialErrors === null && (
          <>
            <label className="ssh-import__entry">
              <input
                type="checkbox"
                checked={copies}
                disabled={busy}
                onChange={(event) => setCopies(event.target.checked)}
              />
              <span>{t("hostTransfer.copies")}</span>
            </label>
            <Button
              size="sm"
              disabled={busy || (!eligible.length && !chosen.size)}
              onClick={() =>
                setChosen((current) =>
                  clearSelection ? new Set() : updateSelection(current, eligible, true),
                )
              }
            >
              {t(clearSelection ? "hostTransfer.clearSelection" : "hostTransfer.selectEligible")}
            </Button>
            {conflict && (
              <p role="status" className="td-field__hint">
                {t("hostTransfer.conflict")}
              </p>
            )}
            <div className="ssh-import__entries">
              {preview.entries.map((entry) => (
                <label className="ssh-import__entry" key={entry.id}>
                  <input
                    type="checkbox"
                    checked={selected.has(entry.id)}
                    disabled={busy || (selected.has(entry.id) && !chosen.has(entry.id))}
                    onChange={(event) => {
                      const checked = event.target.checked;
                      setChosen((current) => updateSelection(current, [entry.id], checked));
                    }}
                  />
                  <span className="ssh-import__details">
                    <strong className="ssh-import__alias">{entry.name}</strong>
                    <span className="ssh-import__address">{entry.address}</span>
                    {entry.conflict && <span>{t("hostTransfer.conflictLabel")}</span>}
                    {entry.dependency && <span>{t("hostTransfer.dependency")}</span>}
                    <span>
                      {t("hostTransfer.ruleCounts", {
                        forwards: entry.forwards,
                        mounts: entry.mounts,
                      })}
                    </span>
                    {!!entry.requires.length && (
                      <span>
                        {t("sshImport.via", {
                          names: entry.requires
                            .map((id) => index.entries.get(id)?.name ?? id)
                            .join(" → "),
                        })}
                      </span>
                    )}
                  </span>
                </label>
              ))}
            </div>
            {!!proxies?.length && (
              <p className="td-field__hint">
                {t("hostTransfer.proxies", {
                  names: proxies.map((proxy) => proxy.name).join(", "),
                })}
              </p>
            )}
            {preview.document.mountRules
              .filter((rule) => selected.has(rule.hostId))
              .map((rule) => (
                <label className="ssh-import__details" key={rule.id}>
                  {t("hostTransfer.mountPoint", { name: rule.name })}
                  <Input
                    value={mountPoints[rule.id] ?? rule.mountPoint}
                    disabled={busy}
                    onChange={(event) =>
                      setMountPoints((current) => ({ ...current, [rule.id]: event.target.value }))
                    }
                  />
                </label>
              ))}
          </>
        )}
        {error && (
          <p role="alert" className="td-field__error">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}
