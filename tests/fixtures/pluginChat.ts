import type { PluginChatBlock } from "@/lib/plugins/pluginChat";

export const chat: PluginChatBlock = {
  type: "chat",
  id: "assistant",
  commands: {
    send: "ai.send",
    stop: "ai.stop",
    session: "ai.session",
    configure: "ai.configure",
    approve: "ai.approve",
    recover: "ai.recover",
  },
  sessions: [
    { id: "session-1", title: "First conversation" },
    { id: "session-2", title: "Second conversation" },
  ],
  activeSessionId: "session-1",
  mode: "ask",
  models: [{ id: "provider-1", label: "Test provider" }],
  modelId: "provider-1",
  messages: [],
  run: null,
  approvals: [],
  tasks: [],
  configured: true,
  notice: "",
  config: {
    profiles: [
      {
        id: "provider-1",
        name: "Test provider",
        protocol: "openai-chat",
        baseUrl: "https://api.example.test/v1",
        model: "test-model",
        hasApiKey: true,
        executable: "",
        cwd: "",
        sessionId: "",
      },
    ],
    activeProfileId: "provider-1",
    approverProfileId: "",
    mode: "ask",
    scope: { localRoots: [], sessionIds: [], remoteRoots: [] },
  },
};
