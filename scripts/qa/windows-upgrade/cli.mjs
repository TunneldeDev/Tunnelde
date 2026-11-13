import { join } from "node:path";
import { verifyLocalCli } from "../local-cli/verify.mjs";

export async function verifyCli(binary, version, dataDir, hostId) {
  return verifyLocalCli(binary, version, join(dataDir, "automation.json"), { hostId });
}
