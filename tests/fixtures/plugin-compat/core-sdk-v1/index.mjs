import { createPlugin } from "./sdk.mjs";

createPlugin({
  async run(command, input, host) {
    try {
      return await host.call(input.method, input.params ?? {});
    } catch (error) {
      if (!input.captureError) throw error;
      return { code: error.code, message: error.message, data: error.data };
    }
  },
});
