// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

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

interface SshStore {
  sessions: SshSession[];
  connectingHostId: string | null;
  connectingHostIds: string[];
  disconnectingSessionIds: string[];
  refresh: () => Promise<void>;
  connect: (request: SshConnectRequest) => Promise<SshSession | null>;
  disconnect: (sessionId: string) => Promise<void>;
  forget: (sessionId: string) => void;
}

export const useSsh = create<SshStore>((set, get) => ({
  sessions: [],
  connectingHostId: null,
  connectingHostIds: [],
  disconnectingSessionIds: [],

  refresh: async () => {
    const version = sessionVersion;
    try {
      const sessions = await api.sshSessions();
      if (sessionVersion === version) {
        set({ sessions });
      }
    } catch {
      // A missing session list never blocks the workspace.
    }
  },

  connect: (request) => {
    const existing = connections.get(request.hostId);
    if (existing) {
      return existing;
    }
    set((state) => ({
      connectingHostId: request.hostId,
      connectingHostIds: [...state.connectingHostIds, request.hostId],
    }));
    const operation = (async () => {
      try {
        const session = await api.sshConnect(request);
        sessionVersion += 1;
        set((state) => ({
          sessions: [...state.sessions.filter((item) => item.id !== session.id), session],
        }));
        void api.markHostUsed(request.hostId).catch(() => undefined);
        return session;
      } catch (error) {
        toast(translateError(error), "error");
        return null;
      } finally {
        connections.delete(request.hostId);
        set((state) => {
          const connectingHostIds = state.connectingHostIds.filter((id) => id !== request.hostId);
          return { connectingHostIds, connectingHostId: connectingHostIds.at(-1) ?? null };
        });
      }
    })();
    connections.set(request.hostId, operation);
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
