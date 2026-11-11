import { installDependencies } from "./apt.mjs";
if (process.platform !== "linux" || process.getuid() !== 0)
  throw new Error("Run this CI-only installer as root on Linux");
await installDependencies();
