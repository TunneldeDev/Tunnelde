import { create } from "zustand";

import { translateError } from "@/lib/api/errors";
import { api } from "@/lib/api/ipc";
import type { SshConnectRequest, SshSession } from "@/lib/api/types";
import { toast } from "@/store/toasts";
import { useWorkspace } from "@/store/workspace";
import { useMonitor } from "@/store/monitor";

const connections = new Map<string, Promise<SshSession | null>>();
const disconnections = new Map<string, Promise<void>>();
let sessionVersion = 0;
let snapshotVersion = 0;

interface SshStore {
  sessions: SshSession[];
  connectingHostId: string | null;
  connectingHostIds: string[];
  disconnectingSessionIds: string[];
  refresh: () => Promise<void>;
  connect: (
    request: SshConnectRequest,
    onError?: (error: unknown) => void,
  ) => Promise<SshSession | null>;
  disconnect: (sessionId: string) => Promise<void>;
  forget: (sessionId: string) => void;
  renameHost: (hostId: string, title: string) => void;
}

export const useSsh = create<SshStore>((set, get) => ({
  sessions: [],
  connectingHostId: null,
  connectingHostIds: [],
  disconnectingSessionIds: [],

  renameHost: (hostId, title) => {
    sessionVersion += 1;
    set((state) => ({
      sessions: state.sessions.map((session) =>
        session.hostId === hostId ? { ...session, title } : session,
      ),
    }));
  },

  refresh: async () => {
    const version = sessionVersion;
    const request = ++snapshotVersion;
    try {
      const sessions = await api.sshSessions();
      if (sessionVersion === version && snapshotVersion === request) {
        const alive = new Set(sessions.map((session) => session.id));
        const ended = get().sessions.filter((session) => !alive.has(session.id));
        set({ sessions });
        for (const session of ended) {
          useMonitor.getState().forget(session.id);
          useWorkspace.getState().closeSession(session.id);
        }
      }
    } catch {
      // A missing session list never blocks the workspace.
    }
  },

  connect: (request, onError) => {
    const connectionKey = `${request.hostId}:${request.purpose ?? (request.background ? "background" : "terminal")}`;
    const existing = connections.get(connectionKey);
    if (existing) {
      return existing;
    }
    set((state) => ({
      connectingHostId: request.hostId,
      connectingHostIds: [...new Set([...state.connectingHostIds, request.hostId])],
    }));
    const operation = (async () => {
      try {
        const session = await api.sshConnect(request);
        sessionVersion += 1;
        set((state) => ({
          sessions: [...state.sessions.filter((item) => item.id !== session.id), session],
        }));
        if (!request.hostId.startsWith("source:"))
          void api.markHostUsed(request.hostId).catch(() => undefined);
        return session;
      } catch (error) {
        if (onError) onError(error);
        else toast(translateError(error), "error");
        return null;
      } finally {
        connections.delete(connectionKey);
        set((state) => {
          const connectingHostIds = [...connections.keys()].some((key) =>
            key.startsWith(`${request.hostId}:`),
          )
            ? state.connectingHostIds
            : state.connectingHostIds.filter((id) => id !== request.hostId);
          return { connectingHostIds, connectingHostId: connectingHostIds.at(-1) ?? null };
        });
      }
    })();
    connections.set(connectionKey, operation);
    return operation;
  },

  disconnect: (sessionId) => {
    const existing = disconnections.get(sessionId);
    if (existing) {
      return existing;
    }
    set((state) => ({ disconnectingSessionIds: [...state.disconnectingSessionIds, sessionId] }));
    const operation = (async () => {
      try {
        await api.sshDisconnect(sessionId);
        get().forget(sessionId);
        useWorkspace.getState().closeSession(sessionId);
      } catch (error) {
        toast(translateError(error), "error");
      } finally {
        disconnections.delete(sessionId);
        set((state) => ({
          disconnectingSessionIds: state.disconnectingSessionIds.filter((id) => id !== sessionId),
        }));
      }
    })();
    disconnections.set(sessionId, operation);
    return operation;
  },

  forget: (sessionId) => {
    sessionVersion += 1;
    useMonitor.getState().forget(sessionId);
    set((state) => ({ sessions: state.sessions.filter((item) => item.id !== sessionId) }));
  },
}));
