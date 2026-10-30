// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

import { RefreshCw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button, IconButton } from "@/components/ui/form/Button";
import { Dialog } from "@/components/ui/overlay/Dialog";
import { translateError } from "@/lib/api/errors";
import { formatBytes, formatPercent } from "@/lib/text/format";
import { api } from "@/lib/api/ipc";
import type { RemoteProcess } from "@/lib/api/types";
import { useDialogs } from "@/store/dialogs";

interface ProcessesDialogProps {
  sessionId: string;
  onClose: () => void;
}

export function ProcessesDialog({ sessionId, onClose }: ProcessesDialogProps) {
  const { t } = useTranslation();
  const confirm = useDialogs((state) => state.confirm);
  const [items, setItems] = useState<RemoteProcess[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setItems(await api.remoteProcesses(sessionId));
      setError(null);
    } catch (cause) {
      setError(translateError(cause));
    }
  }, [sessionId]);

  useEffect(() => {
    let alive = true;
    api
      .remoteProcesses(sessionId)
      .then((list) => {
        if (alive) {
          setItems(list);
          setError(null);
        }
      })
      .catch((cause: unknown) => {
        if (alive) {
          setError(translateError(cause));
        }
      });
    return () => {
      alive = false;
    };
  }, [sessionId]);

  const kill = (process: RemoteProcess) => {
    confirm({
      title: t("processes.killTitle"),
      body: t("processes.killBody", { name: process.name, pid: process.pid }),
      confirmLabel: t("processes.kill"),
      danger: true,
      onConfirm: async () => {
        try {
          await api.remoteKill(sessionId, process.pid);
          await load();
        } catch (cause) {
          setError(translateError(cause));
        }
      },
    });
  };

  return (
    <Dialog
      open
      title={t("processes.title")}
      closeLabel={t("common.close")}
      onClose={onClose}
      width={560}
      footer={
        <>
          <Button variant="ghost" leading={<RefreshCw size={13} />} onClick={() => void load()}>
            {t("processes.refresh")}
          </Button>
          <Button variant="secondary" onClick={onClose}>
            {t("common.close")}
          </Button>
        </>
      }
    >
      {error ? <p className="connect__error">{error}</p> : null}
      <div className="proc-table">
        <div className="proc-table__head">
          <span>{t("processes.name")}</span>
          <span>{t("processes.pid")}</span>
          <span>{t("processes.cpu")}</span>
          <span>{t("processes.memory")}</span>
          <span />
        </div>
        <div className="proc-table__body">
          {items === null ? (
            <p className="sftp-pane__empty">{t("common.loading")}</p>
          ) : items.length === 0 ? (
            <p className="sftp-pane__empty">{t("processes.empty")}</p>
          ) : (
            items.map((process) => (
              <div key={process.pid} className="proc-table__row">
                <span className="proc-table__name" title={process.name}>
                  {process.name}
                </span>
                <span className="proc-table__num">{process.pid}</span>
                <span className="proc-table__num">{formatPercent(process.cpu)}</span>
                <span className="proc-table__num" title={formatBytes(process.rss)}>
                  {formatPercent(process.memory)}
                </span>
                <IconButton
                  label={t("processes.kill")}
                  size="sm"
                  disabled={process.pid <= 1}
                  onClick={() => kill(process)}
                >
                  <Trash2 size={12} />
                </IconButton>
              </div>
            ))
          )}
        </div>
      </div>
    </Dialog>
  );
}
