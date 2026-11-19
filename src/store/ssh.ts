import { create } from "zustand";

import { translateError } from "@/lib/api/errors";
import { api } from "@/lib/api/ipc";
import type { SshConnectRequest, SshSession } from "@/lib/api/types";
import { toast } from "@/store/toasts";
import { useWorkspace } from "@/store/workspace";
import { useMonitor } from "@/store/monitor";

import { recordSessionEvent, type SessionHistory } from "./sshHistory";

const connections = new Map<string, Promise<SshSession | null>>();
const disconnections = new Map<string, Promise<void>>();
let sessionVersion = 0;
let snapshotVersion = 0;

interface SshStore {
  sessions: SshSession[];
  history: SessionHistory[];
  connectingHostId: string | null;
  connectingHostIds: string[];
  disconnectingSessionIds: string[];
  refresh: () => Promise<void>;
  /** Record a native-accepted published connection before mounting its consumers. */
  acceptSession: (session: SshSession) => void;
  connect: (
    request: SshConnectRequest,
    onError?: (error: unknown) => void,
    acquisition?: { key: string; connect: (request: SshConnectRequest) => Promise<SshSession> },
  ) => Promise<SshSession | null>;
  disconnect: (sessionId: string) => Promise<void>;
  forget: (sessionId: string, reason?: string) => void;
  renameHost: (hostId: string, title: string) => void;
}

export const useSsh = create<SshStore>((set, get) => ({
  sessions: [],
  history: [],
  connectingHostId: null,
  connectingHostIds: [],
  disconnectingSessionIds: [],

  acceptSession: (session) => {
    sessionVersion += 1;
    set((state) => ({
      sessions: [...state.sessions.filter((item) => item.id !== session.id), session],
      history: recordSessionEvent(state.history, session, "connected"),
    }));
  },

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
        let history = get().history;
        for (const session of sessions) history = recordSessionEvent(history, session, "connected");
        for (const session of ended) history = recordSessionEvent(history, session, "ended");
        set({ sessions, history });
        for (const session of ended) {
          useMonitor.getState().forget(session.id);
          useWorkspace.getState().closeSession(session.id);
        }
      }
    } catch {
      // A missing session list never blocks the workspace.
    }
  },

  connect: (request, onError, acquisition) => {
    const connectionKey = `${request.hostId}:${request.purpose ?? (request.background ? "background" : "terminal")}:${acquisition?.key ?? "native"}`;
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
        const session = await (acquisition?.connect ?? api.sshConnect)(request);
        get().acceptSession(session);
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
    const session = get().sessions.find((item) => item.id === sessionId);
    if (!session) return Promise.resolve();
    set((state) => ({
      disconnectingSessionIds: [...state.disconnectingSessionIds, sessionId],
      history: recordSessionEvent(state.history, session, "disconnecting"),
    }));
    const operation = (async () => {
      try {
        await api.sshDisconnect(sessionId);
        get().forget(sessionId);
        useWorkspace.getState().closeSession(sessionId);
      } catch (error) {
        if (get().sessions.some((item) => item.id === sessionId)) {
          set((state) => ({
            history: recordSessionEvent(
              state.history,
              session,
              "disconnectFailed",
              translateError(error),
            ),
          }));
        }
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

  forget: (sessionId, reason) => {
    sessionVersion += 1;
    useMonitor.getState().forget(sessionId);
    set((state) => {
      const session = state.sessions.find((item) => item.id === sessionId);
      return {
        sessions: state.sessions.filter((item) => item.id !== sessionId),
        history: session
          ? recordSessionEvent(state.history, session, "ended", reason)
          : state.history,
      };
    });
  },
}));
