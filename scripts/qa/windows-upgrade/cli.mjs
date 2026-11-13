import { join } from "node:path";
import { verifyLocalCli } from "../local-cli/verify.mjs";

export async function verifyCli(binary, version, root, hostId) {
  return verifyLocalCli(binary, version, join(root, "data", "automation.json"), { hostId });
}
