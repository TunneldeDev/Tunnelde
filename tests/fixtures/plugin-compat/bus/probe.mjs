import { pathToFileURL } from "node:url";
import process from "node:process";

const { createPlugin } = await import(pathToFileURL(process.argv[2]).href);
createPlugin({
  async run(_command, { method, params }, host) {
    try {
      return await host.call(method, params);
    } catch (error) {
      return { error: error.message };
    }
  },
});
