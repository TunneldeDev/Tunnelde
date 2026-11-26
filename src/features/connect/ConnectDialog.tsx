import { useMemo, useState, type ReactNode } from "react";
import { api } from "@/lib/api/ipc";
import { createReviewedConnection, type ConnectionReview } from "@/lib/api/connections/review";
import type { Host, HostKeyInfo, SshConnectRequest, SshSession } from "@/lib/api/types";
import { useHosts } from "@/store/hosts";
import { useSsh } from "@/store/ssh";
import { usePanelWindows } from "@/store/panelWindows";
import { useWorkspace } from "@/store/workspace";
import { ConnectionPrompt } from "./ConnectionPrompt";
import { connectionPromptHost, type ConnectionPromptServices } from "./prompt";

interface ConnectDialogProps {
  host: Host;
  after?: "terminal" | "sftp" | "monitor" | "processes" | "background";
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
  const satellite = usePanelWindows((s) => s.windowId !== "main");
  if (satellite) throw new Error("panel.window.unsupportedView");
  const host = props.host;
  const scope = JSON.stringify([
    host.id,
    host.host,
    host.port,
    host.username,
    host.authMethod,
    host.keyPath,
  ]);
  return <LocalConnectDialog key={scope} {...props} />;
}

function LocalConnectDialog({
  host,
  connectSession,
  verification,
  onConnected,
  after = "terminal",
  ...props
}: ConnectDialogProps) {
  const [reviewed] = useState(() => createReviewedConnection(host));
  const services = useMemo<ConnectionPromptServices>(
    () => ({
      prepare: async () => {
        const plan = verification
          ? {
              jumpHosts:
                verification.jumpHosts ??
                (await api.connectionRoute(host.id)).jumpHosts
                  .map((id) => useHosts.getState().hosts.find((h) => h.id === id))
                  .filter((h): h is Host => !!h),
            }
          : await reviewed.prepare();
        return { jumpHosts: plan.jumpHosts.map(connectionPromptHost) };
      },
      credentialStatus: api.credentialStatus,
      probe: (credentials) =>
        verification ? verification.probe(credentials) : reviewed.probe(credentials),
      trust: (fingerprint, credentials, expectedHostId) =>
        verification
          ? verification.trust(fingerprint, credentials, expectedHostId)
          : reviewed.trust(fingerprint, credentials, expectedHostId),
      connect: async (request) => {
        if (connectSession)
          return connectSession(request, verification ? undefined : await reviewed.review());
        let failure: unknown;
        const session = await useSsh.getState().connect(
          request,
          (cause) => {
            failure = cause;
          },
          { key: reviewed.key, connect: reviewed.connect },
        );
        if (!session && failure) throw failure;
        return session;
      },
      test: reviewed.test,
      cancelTest: api.sshCancelTest,
      credential: reviewed.credential,
      installKey: async (password, credentials) => {
        const result = await reviewed.installKey(password, credentials);
        await useHosts.getState().load();
        return result;
      },
    }),
    [host.id, reviewed, verification, connectSession],
  );
  return (
    <ConnectionPrompt
      {...props}
      host={connectionPromptHost(host)}
      services={services}
      pinned={!!verification}
      after={after}
      onConnected={async (session) => {
        if (onConnected) await onConnected(session);
        else if (after === "processes") useWorkspace.getState().openProcesses(session);
        else if (after === "monitor") useWorkspace.getState().openMonitor(session);
        else if (after === "sftp") useWorkspace.getState().openSftp(session);
        else if (after === "terminal") useWorkspace.getState().openTerminal(session);
      }}
    />
  );
}
