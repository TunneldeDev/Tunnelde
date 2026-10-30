// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

import { create } from "zustand";

import { translateError } from "@/lib/errors";
import { api } from "@/lib/ipc";
import type { SshConnectRequest, SshSession } from "@/lib/types";
import { toast } from "@/store/toasts";
import { useWorkspace } from "@/store/workspace";

interface SshStore {
  sessions: SshSession[];
  connectingHostId: string | null;
  refresh: () => Promise<void>;
  connect: (request: SshConnectRequest) => Promise<SshSession | null>;
  disconnect: (sessionId: string) => Promise<void>;
  forget: (sessionId: string) => void;
}

export const useSsh = create<SshStore>((set, get) => ({
  sessions: [],
  connectingHostId: null,

  refresh: async () => {
    try {
      set({ sessions: await api.sshSessions() });
    } catch {
      // A missing session list never blocks the workspace.
    }
  },

  connect: async (request) => {
    set({ connectingHostId: request.hostId });
    try {
      const session = await api.sshConnect(request);
      set((state) => ({
        sessions: [...state.sessions.filter((item) => item.id !== session.id), session],
        connectingHostId: null,
      }));
      void api.markHostUsed(request.hostId).catch(() => undefined);
      return session;
    } catch (error) {
      set({ connectingHostId: null });
      toast(translateError(error), "error");
      return null;
    }
  },

  disconnect: async (sessionId) => {
    try {
      await api.sshDisconnect(sessionId);
    } catch (error) {
      toast(translateError(error), "error");
    } finally {
      get().forget(sessionId);
      useWorkspace.getState().closeSession(sessionId);
    }
  },

  forget: (sessionId) => {
    set((state) => ({ sessions: state.sessions.filter((item) => item.id !== sessionId) }));
  },
}));
