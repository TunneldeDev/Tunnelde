export class PluginInvocationCancelled extends Error {
  constructor() {
    super("plugin.invocation.cancelled");
    this.name = "PluginInvocationCancelled";
  }
}

export const isPluginInvocationCancelled = (error: unknown) =>
  error instanceof PluginInvocationCancelled;
