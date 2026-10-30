// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

import { Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { IconButton } from "@/components/ui/form/Button";
import { translateError } from "@/lib/api/errors";
import { api } from "@/lib/api/ipc";
import type { KnownHostEntry } from "@/lib/api/types";
import { useDialogs } from "@/store/dialogs";
import { toast } from "@/store/toasts";

export function KnownHostsList() {
  const { t } = useTranslation();
  const confirm = useDialogs((state) => state.confirm);
  const [entries, setEntries] = useState<KnownHostEntry[] | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .knownHostsList()
      .then((list) => {
        if (alive) {
          setEntries(list);
        }
      })
      .catch((error: unknown) => {
        if (alive) {
          toast(translateError(error), "error");
        }
      });
    return () => {
      alive = false;
    };
  }, []);

  const forget = (entry: KnownHostEntry) => {
    confirm({
      title: t("settings.knownHostsForgetTitle"),
      body: t("settings.knownHostsForgetBody", { host: entry.host, port: entry.port }),
      confirmLabel: t("settings.knownHostsForget"),
      danger: true,
      onConfirm: async () => {
        try {
          await api.knownHostsForget(entry.host, entry.port);
          setEntries(
            (current) =>
              current?.filter((item) => !(item.host === entry.host && item.port === entry.port)) ??
              null,
          );
        } catch (error) {
          toast(translateError(error), "error");
        }
      },
    });
  };

  if (entries !== null && entries.length === 0) {
    return <p className="settings-hint">{t("settings.knownHostsEmpty")}</p>;
  }

  return (
    <div className="known-hosts">
      {(entries ?? []).map((entry) => (
        <div className="known-host" key={`${entry.host}:${entry.port}`}>
          <span className="known-host__address">
            {entry.host}:{entry.port}
          </span>
          <span className="known-host__algorithm">{entry.algorithm}</span>
          <code className="known-host__fingerprint" title={entry.fingerprint}>
            {entry.fingerprint}
          </code>
          <IconButton
            label={t("settings.knownHostsForget")}
            size="sm"
            danger
            onClick={() => forget(entry)}
          >
            <Trash2 size={12} />
          </IconButton>
        </div>
      ))}
    </div>
  );
}
