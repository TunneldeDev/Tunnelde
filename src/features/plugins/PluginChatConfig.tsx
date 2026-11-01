import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { FolderOpen, Plus, Trash2 } from "lucide-react";
import { api, isTauri } from "@/lib/api/ipc";
import { translateError } from "@/lib/api/errors";
import { useSsh } from "@/store/ssh";
import { Button, IconButton } from "@/components/ui/form/Button";
import { Field, Input, Switch } from "@/components/ui/form/Field";
import { Select } from "@/components/ui/form/Select";
import { Dialog } from "@/components/ui/overlay/Dialog";
import {
  CHAT_PROTOCOLS,
  type ChatProfile,
  type ChatProfilePolicy,
  type ChatProtocol,
  type PluginChatConfig,
} from "@/lib/plugins/pluginChat";

interface ProfileDraft extends ChatProfile {
  apiKey?: string;
}
export interface ChatConfigDraft extends PluginChatConfig {
  profiles: ProfileDraft[];
}
const EMPTY: ChatConfigDraft = {
  profiles: [],
  activeProfileId: "",
  approverProfileId: "",
  mode: "ask",
  scope: { localRoots: [], sessionIds: [], remoteRoots: [] },
};
const cli = (protocol: string) => ["codex", "claude-code", "pi"].includes(protocol);
function SessionChoice({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const { t } = useTranslation();
  const sessions = useSsh((state) => state.sessions);
  const options = sessions.map((session) => ({
    value: session.id,
    label: session.title || session.address,
  }));
  if (value && !options.some((option) => option.value === value))
    options.push({ value, label: value });
  return (
    <Select
      label={label}
      value={value}
      options={[{ value: "", label: t("pluginChat.chooseSession") }, ...options]}
      onChange={onChange}
    />
  );
}
function ConfigInput({
  label,
  value,
  onChange,
  secret = false,
  placeholder = "",
  onBrowse,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  secret?: boolean;
  placeholder?: string;
  onBrowse?: () => void;
}) {
  const id = useId();
  const { t } = useTranslation();
  return (
    <Field label={label} htmlFor={id}>
      <div className="plugin-chat-config__row">
        <Input
          id={id}
          type={secret ? "password" : "text"}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          autoComplete="off"
          spellCheck={false}
          placeholder={placeholder}
        />
        {onBrowse ? (
          <IconButton
            label={`${t("pluginChat.browse")} · ${label}`}
            disabled={!isTauri()}
            onClick={onBrowse}
          >
            <FolderOpen size={14} />
          </IconButton>
        ) : null}
      </div>
    </Field>
  );
}
function StringList({
  label,
  values,
  onChange,
  session = false,
  onBrowse,
}: {
  label: string;
  values: string[];
  onChange: (values: string[]) => void;
  session?: boolean;
  onBrowse?: () => void;
}) {
  const { t } = useTranslation();
  return (
    <fieldset className="plugin-chat-config__list">
      <legend>{label}</legend>
      {values.map((value, index) => (
        <div className="plugin-chat-config__row" key={index}>
          {session ? (
            <SessionChoice
              label={`${label} ${index + 1}`}
              value={value}
              onChange={(next) => onChange(values.map((item, at) => (at === index ? next : item)))}
            />
          ) : (
            <Input
              aria-label={`${label} ${index + 1}`}
              value={value}
              onChange={(event) =>
                onChange(values.map((item, at) => (at === index ? event.target.value : item)))
              }
            />
          )}
          <IconButton
            label={t("pluginChat.removeItem")}
            onClick={() => onChange(values.filter((_, at) => at !== index))}
          >
            <Trash2 size={13} />
          </IconButton>
        </div>
      ))}
      <Button
        size="sm"
        variant="ghost"
        onClick={() => onChange([...values, ""])}
        leading={<Plus size={13} />}
      >
        {t("pluginChat.addItem")}
      </Button>
      {onBrowse ? (
        <Button
          size="sm"
          variant="ghost"
          disabled={!isTauri()}
          onClick={onBrowse}
          leading={<FolderOpen size={13} />}
        >
          {t("pluginChat.browse")}
        </Button>
      ) : null}
    </fieldset>
  );
}

export function PluginChatConfigDialog({
  config,
  title,
  profilePolicy,
  busy,
  error,
  onClose,
  onSave,
}: {
  config?: PluginChatConfig;
  title?: string;
  profilePolicy?: ChatProfilePolicy;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onSave: (draft: ChatConfigDraft) => Promise<boolean>;
}) {
  const { t } = useTranslation();
  // Secrets exist only in this mounted editor; the plugin stores them in the OS credential vault.
  const [draft, setDraft] = useState<ChatConfigDraft>(() => structuredClone(config ?? EMPTY));
  const [section, setSection] = useState<"profiles" | "reviewers" | "scope">("profiles");
  const [picking, setPicking] = useState(false);
  const [pickerError, setPickerError] = useState<string | null>(null);
  const pick = async (kind: "file" | "folder", label: string, apply: (value: string) => void) => {
    if (picking) return;
    setPicking(true);
    setPickerError(null);
    try {
      const value = await (kind === "file"
        ? api.pluginPickExecutable(label)
        : api.pluginPickFolder(label));
      if (value) apply(value);
    } catch (cause) {
      setPickerError(translateError(cause));
    } finally {
      setPicking(false);
    }
  };
  const profile = (id: string, patch: Partial<ProfileDraft>) =>
    setDraft((current) => ({
      ...current,
      profiles: current.profiles.map((item) => (item.id === id ? { ...item, ...patch } : item)),
    }));
  const primaryProtocols = profilePolicy?.primaryProtocols ?? [...CHAT_PROTOCOLS];
  const reviewerProtocols =
    profilePolicy?.reviewerProtocols ?? CHAT_PROTOCOLS.filter((protocol) => !cli(protocol));
  const splitReviewers =
    !!profilePolicy && !primaryProtocols.some((protocol) => reviewerProtocols.includes(protocol));
  const primaryProfiles = draft.profiles.filter((item) => primaryProtocols.includes(item.protocol));
  const reviewerProfiles = draft.profiles.filter((item) =>
    reviewerProtocols.includes(item.protocol),
  );
  const visibleProfiles =
    section === "reviewers" ? reviewerProfiles : splitReviewers ? primaryProfiles : draft.profiles;
  const choices = primaryProfiles.map((item) => ({ value: item.id, label: item.name || item.id }));
  const protocolChoices = section === "reviewers" ? reviewerProtocols : primaryProtocols;
  const dialogTitle = title
    ? t("pluginChat.configureNamed", { name: title })
    : t("pluginChat.configure");
  const addProfile = () => {
    const id = crypto.randomUUID();
    const protocol =
      section === "reviewers"
        ? reviewerProtocols[0]
        : (profilePolicy?.defaultProtocol ?? "openai-chat");
    if (!protocol) return;
    setDraft((current) => ({
      ...current,
      activeProfileId:
        section === "reviewers" ? current.activeProfileId : current.activeProfileId || id,
      approverProfileId:
        section === "reviewers" ? current.approverProfileId || id : current.approverProfileId,
      profiles: [
        ...current.profiles,
        {
          id,
          name: "",
          protocol,
          baseUrl: "",
          model: "",
          hasApiKey: false,
          executable: "",
          cwd: "",
          sessionId: "",
        },
      ],
    }));
  };
  return (
    <Dialog
      open
      title={dialogTitle}
      onClose={onClose}
      closeLabel={t("common.close")}
      dismissible={!busy && !picking}
      width={760}
      footer={
        <>
          <Button disabled={busy || picking} onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button
            variant="primary"
            disabled={busy || picking}
            onClick={() =>
              void onSave({
                ...draft,
                scope: {
                  localRoots: draft.scope.localRoots.map((value) => value.trim()).filter(Boolean),
                  sessionIds: draft.scope.sessionIds.map((value) => value.trim()).filter(Boolean),
                  remoteRoots: draft.scope.remoteRoots.filter(
                    (root) => root.sessionId.trim() && root.path.trim(),
                  ),
                },
              }).then((ok) => {
                if (ok) onClose();
              })
            }
          >
            {t("common.save")}
          </Button>
        </>
      }
    >
      <p className="settings-hint">{t("pluginChat.credentialsHint")}</p>
      <div className="plugin-chat-config__tabs" role="group" aria-label={dialogTitle}>
        {(["profiles", ...(splitReviewers ? ["reviewers" as const] : []), "scope"] as const).map(
          (item) => (
            <Button
              key={item}
              variant={section === item ? "secondary" : "ghost"}
              onClick={() => setSection(item)}
            >
              {t(item === "reviewers" ? "pluginChat.reviewerProfiles" : `pluginChat.${item}`)}
            </Button>
          ),
        )}
      </div>
      <fieldset className="plugin-chat-config" disabled={busy || picking}>
        {section !== "scope" ? (
          <>
            {section === "reviewers" ? (
              <p className="settings-hint">{t("pluginChat.reviewerProfilesHint")}</p>
            ) : null}
            <div className="plugin-chat-config__grid">
              {section === "profiles" ? (
                <Field label={t("pluginChat.activeProfile")}>
                  <Select
                    label={t("pluginChat.activeProfile")}
                    value={draft.activeProfileId}
                    options={[{ value: "", label: t("pluginChat.chooseProfile") }, ...choices]}
                    onChange={(activeProfileId) =>
                      setDraft((current) => ({
                        ...current,
                        activeProfileId,
                        approverProfileId:
                          current.approverProfileId === activeProfileId
                            ? ""
                            : current.approverProfileId,
                      }))
                    }
                  />
                </Field>
              ) : null}
              {!splitReviewers || section === "reviewers" ? (
                <Field label={t("pluginChat.approverProfile")} hint={t("pluginChat.approverHint")}>
                  <Select
                    label={t("pluginChat.approverProfile")}
                    value={draft.approverProfileId}
                    options={[
                      { value: "", label: t("pluginChat.manualFallback") },
                      ...reviewerProfiles
                        .filter((item) => item.id !== draft.activeProfileId)
                        .map((item) => ({ value: item.id, label: item.name || item.id })),
                    ]}
                    onChange={(approverProfileId) =>
                      setDraft((current) => ({ ...current, approverProfileId }))
                    }
                  />
                </Field>
              ) : null}
            </div>
            {visibleProfiles.map((item, index) => (
              <section
                className="plugin-chat-config__card"
                key={item.id}
                aria-label={`${t("pluginChat.profile")} ${index + 1}`}
              >
                <div className="plugin-chat-config__card-head">
                  <strong>{item.name || t("pluginChat.profile")}</strong>
                  <IconButton
                    label={t("pluginChat.removeProfile")}
                    onClick={() =>
                      setDraft((current) => ({
                        ...current,
                        profiles: current.profiles.filter((entry) => entry.id !== item.id),
                        activeProfileId:
                          current.activeProfileId === item.id ? "" : current.activeProfileId,
                        approverProfileId:
                          current.approverProfileId === item.id ? "" : current.approverProfileId,
                      }))
                    }
                  >
                    <Trash2 size={14} />
                  </IconButton>
                </div>
                <div className="plugin-chat-config__grid">
                  <ConfigInput
                    label={t("pluginChat.profileName")}
                    value={item.name}
                    onChange={(name) => profile(item.id, { name })}
                  />
                  {protocolChoices.length > 1 ? (
                    <Field label={t("pluginChat.protocol")}>
                      <Select
                        label={t("pluginChat.protocol")}
                        value={item.protocol}
                        options={protocolChoices.map((value) => ({ value, label: value }))}
                        onChange={(protocol) =>
                          profile(item.id, { protocol: protocol as ChatProtocol })
                        }
                      />
                    </Field>
                  ) : (
                    <Field label={t("pluginChat.protocol")}>
                      <span>{title || item.protocol}</span>
                    </Field>
                  )}
                  <ConfigInput
                    label={t("pluginChat.model")}
                    value={item.model}
                    onChange={(model) => profile(item.id, { model })}
                  />
                  {cli(item.protocol) ? (
                    <>
                      <ConfigInput
                        label={t("pluginChat.executable")}
                        value={item.executable}
                        onChange={(executable) => profile(item.id, { executable })}
                        onBrowse={
                          !item.remote
                            ? () =>
                                void pick("file", t("pluginChat.executable"), (executable) =>
                                  profile(item.id, { executable }),
                                )
                            : undefined
                        }
                      />
                      <ConfigInput
                        label={t("pluginChat.cwd")}
                        value={item.cwd}
                        onChange={(cwd) => profile(item.id, { cwd })}
                        onBrowse={
                          !item.remote
                            ? () =>
                                void pick("folder", t("pluginChat.cwd"), (cwd) =>
                                  profile(item.id, { cwd }),
                                )
                            : undefined
                        }
                      />
                      <div className="plugin-chat-config__row">
                        <span>{t("pluginChat.remoteEnabled")}</span>
                        <Switch
                          label={t("pluginChat.remoteEnabled")}
                          checked={!!item.remote}
                          onChange={(enabled) =>
                            profile(item.id, {
                              remote: enabled
                                ? {
                                    sessionId: item.sessionId,
                                    platform: "posix",
                                    directory: "",
                                    runnerPath: "",
                                    executable: "",
                                  }
                                : undefined,
                              sessionId: "",
                            })
                          }
                        />
                      </div>
                      {item.remote ? (
                        <>
                          <Field label={t("pluginChat.remoteSession")}>
                            <SessionChoice
                              label={t("pluginChat.remoteSession")}
                              value={item.remote.sessionId}
                              onChange={(sessionId) =>
                                profile(item.id, { remote: { ...item.remote!, sessionId } })
                              }
                            />
                          </Field>
                          <Field label={t("pluginChat.remotePlatform")}>
                            <Select
                              label={t("pluginChat.remotePlatform")}
                              value={item.remote.platform}
                              options={[
                                { value: "posix", label: "POSIX (Linux / macOS)" },
                                { value: "windows", label: "Windows" },
                              ]}
                              onChange={(platform) =>
                                profile(item.id, {
                                  remote: {
                                    ...item.remote!,
                                    platform: platform as "posix" | "windows",
                                  },
                                })
                              }
                            />
                          </Field>
                          <ConfigInput
                            label={t("pluginChat.remoteDirectory")}
                            value={item.remote.directory}
                            onChange={(directory) =>
                              profile(item.id, { remote: { ...item.remote!, directory } })
                            }
                          />
                          <ConfigInput
                            label={t("pluginChat.remoteNode")}
                            value={item.remote.executable}
                            onChange={(executable) =>
                              profile(item.id, { remote: { ...item.remote!, executable } })
                            }
                          />
                          <ConfigInput
                            label={t("pluginChat.helperBinary")}
                            value={item.helperBinary ?? ""}
                            onChange={(helperBinary) => profile(item.id, { helperBinary })}
                            onBrowse={() =>
                              void pick("file", t("pluginChat.helperBinary"), (helperBinary) =>
                                profile(item.id, { helperBinary }),
                              )
                            }
                          />
                          <p className="settings-hint">{t("pluginChat.remoteHint")}</p>
                        </>
                      ) : null}
                    </>
                  ) : (
                    <>
                      <ConfigInput
                        label={t("pluginChat.baseUrl")}
                        value={item.baseUrl}
                        onChange={(baseUrl) => profile(item.id, { baseUrl })}
                        placeholder="https://…"
                      />
                      <ConfigInput
                        label={t("pluginChat.apiKey")}
                        value={item.apiKey ?? ""}
                        onChange={(apiKey) => profile(item.id, { apiKey })}
                        secret
                        placeholder={t(
                          item.hasApiKey ? "pluginChat.savedSecret" : "pluginChat.enterSecret",
                        )}
                      />
                    </>
                  )}
                </div>
                {cli(item.protocol) ? (
                  <p className="settings-hint">{t("pluginChat.cliHint")}</p>
                ) : null}
              </section>
            ))}
            <Button size="sm" leading={<Plus size={13} />} onClick={addProfile}>
              {t(section === "reviewers" ? "pluginChat.addReviewer" : "pluginChat.addProfile")}
            </Button>
          </>
        ) : (
          <>
            <p className="settings-hint">{t("pluginChat.scopeHint")}</p>
            <StringList
              label={t("pluginChat.localRoots")}
              values={draft.scope.localRoots}
              onBrowse={() =>
                void pick("folder", t("pluginChat.localRoots"), (root) =>
                  setDraft((current) => ({
                    ...current,
                    scope: { ...current.scope, localRoots: [...current.scope.localRoots, root] },
                  })),
                )
              }
              onChange={(localRoots) =>
                setDraft((current) => ({ ...current, scope: { ...current.scope, localRoots } }))
              }
            />
            <StringList
              label={t("pluginChat.sessionIds")}
              values={draft.scope.sessionIds}
              session
              onChange={(sessionIds) =>
                setDraft((current) => ({ ...current, scope: { ...current.scope, sessionIds } }))
              }
            />
            <fieldset className="plugin-chat-config__list">
              <legend>{t("pluginChat.remoteRoots")}</legend>
              {draft.scope.remoteRoots.map((root, index) => (
                <div className="plugin-chat-config__row" key={index}>
                  <SessionChoice
                    label={`${t("pluginChat.remoteSession")} ${index + 1}`}
                    value={root.sessionId}
                    onChange={(sessionId) =>
                      setDraft((current) => ({
                        ...current,
                        scope: {
                          ...current.scope,
                          remoteRoots: current.scope.remoteRoots.map((item, at) =>
                            at === index ? { ...item, sessionId } : item,
                          ),
                        },
                      }))
                    }
                  />
                  <Input
                    aria-label={`${t("pluginChat.remotePath")} ${index + 1}`}
                    value={root.path}
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        scope: {
                          ...current.scope,
                          remoteRoots: current.scope.remoteRoots.map((item, at) =>
                            at === index ? { ...item, path: event.target.value } : item,
                          ),
                        },
                      }))
                    }
                  />
                  <IconButton
                    label={t("pluginChat.removeItem")}
                    onClick={() =>
                      setDraft((current) => ({
                        ...current,
                        scope: {
                          ...current.scope,
                          remoteRoots: current.scope.remoteRoots.filter((_, at) => at !== index),
                        },
                      }))
                    }
                  >
                    <Trash2 size={13} />
                  </IconButton>
                </div>
              ))}
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  setDraft((current) => ({
                    ...current,
                    scope: {
                      ...current.scope,
                      remoteRoots: [...current.scope.remoteRoots, { sessionId: "", path: "" }],
                    },
                  }))
                }
              >
                {t("pluginChat.addItem")}
              </Button>
            </fieldset>
          </>
        )}
      </fieldset>
      {error ? (
        <p role="alert" className="panel__error">
          {error}
        </p>
      ) : null}
      {pickerError ? (
        <p role="alert" className="panel__error">
          {pickerError}
        </p>
      ) : null}
    </Dialog>
  );
}
