import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { runnerRecoveryApi as client } from "@/lib/api/runners/recovery";
import { api } from "@/lib/api/ipc";
import { translateError } from "@/lib/api/errors";
import type { Host, SshConnectRequest } from "@/lib/api/types";
import type { RecoveryEntry } from "@/lib/runners/recovery/contracts";
import { useWorkspace } from "@/store/workspace";
import { useSsh } from "@/store/ssh";
import { toast } from "@/store/toasts";

/** One acquisition per mounted recovery page; no late navigation to another owner. */
export function useRecoveryFiles(pluginId: string) {
  const active = useRef(false);
  const operation = useRef<string | null>(null);
  const [connection, setConnection] = useState<{ id: string; host: Host } | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancel = useCallback(() => {
    const id = operation.current;
    operation.current = null;
    if (id) void client.cancelBrowser(id).catch(() => undefined);
    if (active.current) {
      setConnection(null);
      setPending(false);
    }
  }, []);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      cancel();
    };
  }, [pluginId, cancel]);
  const finish = useCallback(async (id: string) => {
    if (!active.current || operation.current !== id) return;
    const target = await client.openBrowser(id);
    if (!active.current || operation.current !== id) {
      if (target.acquired)
        await api
          .sshDisconnect(target.session.id)
          .catch((error) => toast(translateError(error), "error"));
      return;
    }
    operation.current = null;
    setConnection(null);
    setPending(false);
    const session = target.session;
    useSsh.getState().acceptSession(session);
    useWorkspace.getState().openFilePane(
      {
        source: { kind: "remote", sessionId: session.id },
        path: target.directory,
        ownerSessionId: session.id,
        remoteIdentity: { hostId: session.hostId, address: session.address },
      },
      session.title,
    );
  }, []);
  const browse = useCallback(
    async (entry: RecoveryEntry) => {
      if (!active.current || operation.current) return;
      const id = crypto.randomUUID();
      operation.current = id;
      setPending(true);
      setError(null);
      try {
        const plan = await client.prepareBrowser({ id, pluginId, token: entry.token });
        if (!active.current || operation.current !== id) {
          await client.cancelBrowser(id);
          return;
        }
        if (plan.host) setConnection({ id, host: plan.host });
        else await finish(id);
      } catch (cause) {
        if (active.current && operation.current === id) setError(translateError(cause));
        if (operation.current === id) cancel();
      }
    },
    [pluginId, cancel, finish],
  );
  const id = connection?.id;
  const verification = useMemo(
    () =>
      id
        ? {
            probe: (credentials: SshConnectRequest["jumpCredentials"]) =>
              client.probeBrowser(id, credentials ?? {}),
            trust: (
              fingerprint: string,
              credentials: SshConnectRequest["jumpCredentials"],
              expectedHostId?: string,
            ) => client.trustBrowser(id, fingerprint, credentials ?? {}, expectedHostId),
          }
        : undefined,
    [id],
  );
  return {
    connection,
    verification,
    pending,
    error,
    browse,
    cancel,
    connect: (request: SshConnectRequest) => {
      if (!id || !active.current || operation.current !== id)
        return Promise.reject(new Error("plugin.runners.browserExpired"));
      return client.connectBrowser(id, request);
    },
    connected: async () => {
      if (!id) return;
      try {
        await finish(id);
      } catch (cause) {
        if (active.current && operation.current === id) {
          setError(translateError(cause));
          cancel();
        }
      }
    },
  };
}
